import type { ArchivedIssuesPage, Comment, Issue, IssueDetails } from "@gateweave/track-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ArchiveChanging,
	ArchivedUnavailable,
	archivedFailure,
	fetchArchivedIssues,
	fetchMissingArchived,
	MAX_MISSING_ARCHIVED,
} from "./archived";

function issue(id: string, archivedAt: number | null = 1): Issue {
	return { id, teamId: "t1", number: 1, archivedAt } as Issue;
}

function comment(id: string, issueId: string): Comment {
	return { id, issueId } as Comment;
}

/** Answers each request with what `answer` returns for its URL, and records the URLs asked. */
function serve(answer: (url: URL) => Response | Promise<Response>): string[] {
	const asked: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			const url = new URL(input, "https://track.test");
			asked.push(`${url.pathname}${url.search}`);
			return answer(url);
		}),
	);
	return asked;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchArchivedIssues", () => {
	it("asks for pages until the last, for the team, and holds each issue once", async () => {
		const pages: Record<string, ArchivedIssuesPage> = {
			"": {
				issues: [issue("a"), issue("b")],
				comments: [comment("c1", "a")],
				activities: [],
				next: "b",
			},
			b: {
				issues: [issue("c"), issue("d")],
				comments: [comment("c2", "c")],
				activities: [],
				next: "d",
			},
			// Restored and archived again between pages: on two of them, the later one newer.
			d: {
				issues: [{ ...issue("a"), title: "Again" }],
				comments: [comment("c1", "a")],
				activities: [],
				next: null,
			},
		};
		const asked = serve((url) => {
			const page = pages[url.searchParams.get("after") ?? ""];
			return page ? Response.json(page) : new Response(null, { status: 400 });
		});

		const archived = await fetchArchivedIssues("acme co", "t1");
		expect(asked).toEqual([
			"/api/sync/acme%20co/archive?team=t1&page=1",
			"/api/sync/acme%20co/archive?team=t1&after=b",
			"/api/sync/acme%20co/archive?team=t1&after=d",
		]);
		expect(archived.issues.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
		expect(archived.issues[0]).toMatchObject({ title: "Again" });
		expect(archived.comments.map((row) => row.id)).toEqual(["c1", "c2"]);
	});

	it("asks for every team's without a team, and stops on a page that fails", async () => {
		const asked = serve((url) =>
			url.searchParams.has("after")
				? new Response(null, { status: 503 })
				: Response.json({ issues: [issue("a")], comments: [], activities: [], next: "a" }),
		);
		const failed = await fetchArchivedIssues("acme", null).catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(ArchivedUnavailable);
		expect(failed).toMatchObject({ status: 503 });
		expect(asked).toEqual(["/api/sync/acme/archive?page=1", "/api/sync/acme/archive?after=a"]);
	});

	it("never asks forever for pages that do not move on", async () => {
		const asked = serve(() =>
			Response.json({ issues: [issue("a")], comments: [], activities: [], next: "a" }),
		);
		await expect(fetchArchivedIssues("acme", null)).rejects.toThrow("did not move on");
		expect(asked).toHaveLength(2);
	});

	it("fails on an answer that is not a page, rather than asking for after=undefined", async () => {
		// The whole list, as a server from before pages answers: no `next` at all.
		const asked = serve(() =>
			Response.json({ issues: [issue("a")], comments: [], activities: [] }),
		);
		await expect(fetchArchivedIssues("acme", null)).rejects.toThrow("not a page");
		expect(asked).toEqual(["/api/sync/acme/archive?page=1"]);

		for (const malformed of [
			{ issues: [issue("a")], comments: [], activities: [], next: undefined },
			{ issues: [{ title: "No id" }], comments: [], activities: [], next: null },
			{ issues: "a", comments: [], activities: [], next: null },
			{ issues: [], comments: [], activities: [], next: "" },
			null,
		]) {
			const once = serve(() => Response.json(malformed));
			await expect(fetchArchivedIssues("acme", null)).rejects.toThrow("not a page");
			expect(once).toHaveLength(1);
		}
	});

	it("follows the server's cursor in whatever order its ids sort", async () => {
		// "Z" sorts before "a" in JavaScript; the server's order is its own, and only a cursor
		// that repeats means it is stuck.
		const pages: Record<string, unknown> = {
			"": { issues: [issue("a")], comments: [], activities: [], next: "a" },
			a: { issues: [issue("Z")], comments: [], activities: [], next: "Z" },
			Z: { issues: [], comments: [], activities: [], next: null },
		};
		serve((url) => Response.json(pages[url.searchParams.get("after") ?? ""]));
		const archived = await fetchArchivedIssues("acme", null);
		expect(archived.issues.map((row) => row.id)).toEqual(["a", "Z"]);
	});

	it("is unavailable without a status when the server cannot be reached", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
		);
		await expect(fetchArchivedIssues("acme", null)).rejects.toMatchObject({ status: null });
	});
});

describe("fetchMissingArchived", () => {
	it("sorts the issues the archive left out into restored and archived, and skips deleted", async () => {
		const details = (row: Issue): IssueDetails => ({
			issue: row,
			comments: [comment(`c-${row.id}`, row.id)],
			activities: [],
			proposals: [],
			pullRequests: [],
		});
		serve((url) => {
			const id = url.pathname.split("/").at(-1);
			if (id === "restored") return Response.json(details(issue("restored", null)));
			if (id === "again") return Response.json(details(issue("again")));
			return Response.json({ error: "Issue not found" }, { status: 404 });
		});
		const missing = await fetchMissingArchived("acme", ["restored", "again", "deleted"]);
		expect(missing.restored.issues.map((row) => row.id)).toEqual(["restored"]);
		expect(missing.restored.comments.map((row) => row.id)).toEqual(["c-restored"]);
		expect(missing.archived.issues.map((row) => row.id)).toEqual(["again"]);
	});

	it("fails as the server does, but for a deleted issue", async () => {
		serve(() => new Response(null, { status: 500 }));
		await expect(fetchMissingArchived("acme", ["a"])).rejects.toMatchObject({ status: 500 });
		// No longer a member: the same 404 status, but the workspace's, which fails the export.
		serve(() => Response.json({ error: "Workspace not found" }, { status: 404 }));
		await expect(fetchMissingArchived("acme", ["a"])).rejects.toMatchObject({
			status: 404,
			reason: "Workspace not found",
		});
		// A 404 that does not say which is not taken for a deleted issue either.
		serve(() => new Response(null, { status: 404 }));
		await expect(fetchMissingArchived("acme", ["a"])).rejects.toMatchObject({ status: 404 });
	});

	it("asks for at most a few dozen, and says the archive is changing past that", async () => {
		const asked = serve((url) =>
			Response.json({
				issue: issue(url.pathname.split("/").at(-1) ?? "", null),
				comments: [],
				activities: [],
				proposals: [],
				pullRequests: [],
			}),
		);
		const ids = (count: number) => Array.from({ length: count }, (_, n) => `issue-${n}`);
		const most = await fetchMissingArchived("acme", ids(MAX_MISSING_ARCHIVED));
		expect(most.restored.issues).toHaveLength(MAX_MISSING_ARCHIVED);
		expect(asked).toHaveLength(MAX_MISSING_ARCHIVED);

		const failed = await fetchMissingArchived("acme", ids(MAX_MISSING_ARCHIVED + 1)).catch(
			(error: unknown) => error,
		);
		expect(failed).toBeInstanceOf(ArchiveChanging);
		expect(failed).toMatchObject({ count: MAX_MISSING_ARCHIVED + 1 });
		// Refused before a single request.
		expect(asked).toHaveLength(MAX_MISSING_ARCHIVED);
	});
});

describe("archivedFailure", () => {
	it("words the failure by how the server answered", () => {
		const offline = archivedFailure(null, "3 archived issues", 3);
		expect(offline.title).toBe("Not exported: 3 archived issues need a connection");
		expect(offline.description).toContain("could not be reached");
		expect(archivedFailure(null, "1 archived issue", 1).title).toBe(
			"Not exported: 1 archived issue needs a connection",
		);

		const gone = archivedFailure(404, "3 archived issues", 3);
		expect(gone.title).toBe("Not exported: workspace not found");
		expect(gone.description).toContain("no longer be a member");
		expect(gone.description).not.toContain("could not be reached");
		expect(archivedFailure(403, "3 archived issues", 3).title).toBe(gone.title);

		expect(archivedFailure(401, "3 archived issues", 3).title).toBe("Not exported: signed out");

		for (const status of [500, 502, 503]) {
			const failed = archivedFailure(status, "3 archived issues", 3);
			expect(failed.title).toBe("Not exported: the server had an error");
			expect(failed.description).toContain("Try again");
			expect(failed.description).not.toContain("could not be reached");
		}

		expect(archivedFailure(400, "3 archived issues", 3).description).toContain("400");

		const changing = archivedFailure("changing", "3 archived issues", 3);
		expect(changing.title).toBe("Not exported: the archive is changing");
		expect(changing.description).toContain("Export again in a moment");
	});
});
