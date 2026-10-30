import { describe, expect, it } from "vitest";
import { parseRepository, readGitHubImport } from "./github";

type Route = (url: URL) => Response | undefined;

/** A stand-in for GitHub: answers by path and query, and records what was asked. */
function fakeGitHub(...routes: Route[]) {
	const asked: { url: string; authorization: string | null }[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		asked.push({
			url: url.pathname + url.search,
			authorization: new Headers(init?.headers).get("Authorization"),
		});
		for (const route of routes) {
			const response = route(url);
			if (response) return response;
		}
		return new Response("{}", { status: 404 });
	}) as typeof globalThis.fetch;
	return { fetch, asked };
}

function json(body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), { headers });
}

const repo: Route = (url) =>
	url.pathname === "/repos/acme/api" ? json({ id: 7, full_name: "acme/api" }) : undefined;

function issue(number: number, overrides: Record<string, unknown> = {}) {
	return {
		number,
		title: `Issue ${number}`,
		body: null,
		state: "open",
		state_reason: null,
		labels: [],
		assignee: null,
		milestone: null,
		created_at: `2024-01-0${number}T00:00:00Z`,
		html_url: `https://github.com/acme/api/issues/${number}`,
		comments: 0,
		...overrides,
	};
}

describe("parseRepository", () => {
	it("takes owner/name or a link to anything in the repository", () => {
		for (const value of [
			"acme/api",
			" https://github.com/acme/api ",
			"github.com/acme/api/issues/3",
			"https://github.com/acme/api.git",
			"https://www.github.com/acme/api?tab=readme",
		]) {
			expect(parseRepository(value)).toEqual({ owner: "acme", name: "api" });
		}
		expect(parseRepository("acme")).toBeNull();
		expect(parseRepository("https://gitlab.com/acme/api/x")).toBeNull();
	});
});

describe("readGitHubImport", () => {
	it("reads every page of issues and their comments, leaving pull requests out", async () => {
		const github = fakeGitHub(repo, (url) => {
			if (url.pathname === "/repos/acme/api/issues") {
				return url.searchParams.get("page") === "2"
					? json([
							issue(3, {
								state: "closed",
								state_reason: "not_planned",
								parent_issue_url: "https://api.github.com/repos/acme/api/issues/1",
							}),
							issue(4, {
								state: "closed",
								state_reason: "completed",
								parent_issue_url: "https://api.github.com/repos/other/repo/issues/1",
							}),
						])
					: json(
							[
								issue(1, {
									body: "It breaks.",
									labels: [{ name: "bug", color: "d73a4a" }, "legacy"],
									assignee: { login: "octocat" },
									milestone: { title: "v1" },
									comments: 2,
								}),
								issue(2, { pull_request: { url: "x" } }),
							],
							{
								Link: '<https://api.github.com/repos/acme/api/issues?page=2>; rel="next", <https://api.github.com/repos/acme/api/issues?page=2>; rel="last"',
							},
						);
			}
			if (url.pathname === "/repos/acme/api/issues/comments") {
				return json([
					{
						id: 10,
						issue_url: "https://api.github.com/repos/acme/api/issues/1",
						body: "Seen it too",
						user: { login: "hubot" },
						created_at: "2024-01-05T00:00:00Z",
					},
					{
						id: 11,
						issue_url: "https://api.github.com/repos/acme/api/issues/2",
						body: "On the pull request",
						user: null,
						created_at: "2024-01-05T00:00:00Z",
					},
				]);
			}
		});
		const progress: { issues: number; comments: number }[] = [];
		const source = await readGitHubImport({ owner: "acme", name: "api" }, " ghp_secret ", {
			fetch: github.fetch,
			onProgress: (read) => progress.push(read),
		});

		expect(github.asked.every((ask) => ask.authorization === "Bearer ghp_secret")).toBe(true);
		expect(source.pullRequests).toBe(1);
		expect(source.issues.map((item) => item.sourceId)).toEqual([
			"github:7#1",
			"github:7#3",
			"github:7#4",
		]);
		expect(source.issues[0]).toMatchObject({
			title: "Issue 1",
			description: "It breaks.",
			status: "todo",
			labels: ["bug", "legacy"],
			assignee: { name: "octocat", email: null },
			project: "v1",
			url: "https://github.com/acme/api/issues/1",
			reference: "acme/api#1",
			createdAt: Date.UTC(2024, 0, 1),
			comments: [
				{
					sourceId: "github:comment:10",
					body: "Seen it too",
					author: "hubot",
					createdAt: Date.UTC(2024, 0, 5),
				},
			],
		});
		expect(source.labelColors?.get("bug")).toBe("#d73a4a");
		// Not planned is canceled; a parent in another repository is not kept.
		expect(source.issues[1]).toMatchObject({ status: "canceled", parentSourceId: "github:7#1" });
		expect(source.issues[2]).toMatchObject({ status: "done", parentSourceId: null });
		expect(progress.at(-1)).toEqual({ issues: 3, comments: 1 });
	});

	it("asks for no comments when no issue has any, and sends no token it was not given", async () => {
		const github = fakeGitHub(repo, (url) =>
			url.pathname === "/repos/acme/api/issues" ? json([issue(1)]) : undefined,
		);
		await readGitHubImport({ owner: "acme", name: "api" }, "", { fetch: github.fetch });
		expect(github.asked.map((ask) => ask.url.split("?")[0])).toEqual([
			"/repos/acme/api",
			"/repos/acme/api/issues",
		]);
		expect(github.asked.every((ask) => ask.authorization === null)).toBe(true);
	});

	it("explains what went wrong", async () => {
		const read = (status: number, token: string, headers: Record<string, string> = {}) =>
			readGitHubImport({ owner: "acme", name: "api" }, token, {
				fetch: (async () => new Response("{}", { status, headers })) as typeof fetch,
			});
		await expect(read(404, "")).rejects.toThrow("For a private one, add a token");
		await expect(read(404, "t")).rejects.toThrow("or the token cannot read it");
		await expect(read(401, "t")).rejects.toThrow("did not accept the token");
		await expect(read(403, "", { "X-RateLimit-Remaining": "0" })).rejects.toThrow(
			/limit on requests was reached\. Try again later, or add a token\.$/,
		);
		await expect(read(502, "t")).rejects.toThrow("(502)");
	});
});
