import type { ArchivedIssuesPage, IssueDetails } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Replicas hold an archived issue slim, and its page and exports ask the sync gateway for the
// rest. The gateway checks the session and the membership as it does for the snapshot, and the
// workspace's object answers only for its own issues.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

async function signUp(client: string, name: string, email: string) {
	const response = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({ name, email, password: "a-long-test-password" }),
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, name, email, cookie };
}

async function createWorkspace(
	client: string,
	owner: { id: string; name: string; email: string; cookie: string },
	slug: string,
) {
	const created = await track.fetch(`${origin}/api/auth/organization/create`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": client,
			"content-type": "application/json",
			cookie: owner.cookie,
		},
		body: JSON.stringify({ name: slug, slug }),
	});
	expect(created.status).toBe(200);
	const { id } = (await created.json()) as { id: string };
	// The snapshot makes the owner a member of the workspace's object, as opening it does.
	expect((await get(`/api/sync/${slug}/snapshot`, owner.cookie)).status).toBe(200);
	const member = { id: owner.id, name: owner.name, email: owner.email, image: null, role: "owner" };
	const mutate = (name: string, args: object) => track.mutate(id, member, { name, args });
	expect(await mutate("team.create", { id: "team-eng", key: "ENG", name: "Engineering" })).toEqual(
		expect.objectContaining({ ok: true }),
	);
	return { id, mutate };
}

function get(path: string, cookie: string, headers: Record<string, string> = {}) {
	return track.fetch(`${origin}${path}`, { headers: { cookie, ...headers } });
}

describe("archived issues through the sync gateway", () => {
	it("answers members whole archived issues, and nobody else", async () => {
		const client = "203.0.113.140";
		const owner = await signUp(client, "Ari Archivist", "ari@archive.test");
		const workspace = await createWorkspace(client, owner, "archivists");
		await workspace.mutate("issue.create", {
			id: "issue-old",
			teamId: "team-eng",
			title: "Shipped long ago",
			description: "Only the server keeps this",
			status: "done",
			sortOrder: "a0",
		});
		await workspace.mutate("comment.create", {
			id: "comment-old",
			issueId: "issue-old",
			body: "Done and dusted",
		});
		expect(
			await workspace.mutate("issue.archive", { id: "issue-old", archived: true }),
		).toMatchObject({ ok: true });

		const page = await get("/api/sync/archivists/issues/issue-old", owner.cookie);
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toBe("no-store");
		const details = (await page.json()) as IssueDetails;
		expect(details.issue).toMatchObject({
			description: "Only the server keeps this",
			archivedAt: expect.any(Number),
		});
		expect(details.comments.map((comment) => comment.body)).toEqual(["Done and dusted"]);

		const exported = await get("/api/sync/archivists/archive?team=team-eng", owner.cookie);
		expect(exported.status).toBe(200);
		const archived = (await exported.json()) as ArchivedIssuesPage;
		expect(archived.issues.map((issue) => issue.id)).toEqual(["issue-old"]);
		expect(archived.comments.map((comment) => comment.id)).toEqual(["comment-old"]);
		// One page holds them all; the cursor of the page after is the last id, for the same team.
		expect(archived.next).toBeNull();
		const after = await get(
			"/api/sync/archivists/archive?team=team-eng&after=issue-old",
			owner.cookie,
		);
		expect(await after.json()).toEqual({ issues: [], comments: [], activities: [], next: null });
		const badCursor = await get("/api/sync/archivists/archive?after=", owner.cookie);
		expect(badCursor.status).toBe(400);
		expect(badCursor.headers.get("cache-control")).toBe("no-store");

		// Someone else's workspace: the same 404 as one that does not exist.
		const stranger = await signUp(client, "Sam Stranger", "sam@archive.test");
		for (const path of ["/api/sync/archivists/issues/issue-old", "/api/sync/archivists/archive"]) {
			const refused = await get(path, stranger.cookie);
			expect(refused.status).toBe(404);
			expect(await refused.json()).toEqual({ error: "Workspace not found" });
			// A refusal is never cached, so access granted later is not hidden behind it.
			expect(refused.headers.get("cache-control")).toBe("no-store");
			const signedOut = await get(path, "");
			expect(signedOut.status).toBe(401);
			expect(signedOut.headers.get("cache-control")).toBe("no-store");
			// Cookies ride along on requests from other sites, so those are refused first.
			expect((await get(path, owner.cookie, { origin: "https://evil.test" })).status).toBe(403);
		}
		expect(
			(
				await track.fetch(`${origin}/api/sync/archivists/archive`, {
					method: "POST",
					headers: { cookie: owner.cookie, origin },
				})
			).status,
		).toBe(405);

		// The stranger's own workspace has no such issue, whatever its id elsewhere.
		await createWorkspace(client, stranger, "strangers");
		const elsewhere = await get("/api/sync/strangers/issues/issue-old", stranger.cookie);
		expect(elsewhere.status).toBe(404);
		expect(await elsewhere.json()).toEqual({ error: "Issue not found" });
		expect(elsewhere.headers.get("cache-control")).toBe("no-store");
		expect(
			(
				(await (
					await get("/api/sync/strangers/archive", stranger.cookie)
				).json()) as ArchivedIssuesPage
			).issues,
		).toEqual([]);
		expect((await get("/api/sync/archivists/issues/%E0", owner.cookie)).status).toBe(400);
	});
});
