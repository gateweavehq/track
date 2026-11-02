import { describe, expect, it } from "vitest";
import { listLinearTeams, readLinearImport } from "./linear";

interface Asked {
	query: string;
	variables: Record<string, unknown>;
	authorization: string | null;
}

/** A stand-in for Linear's GraphQL endpoint: answers each query by its operation name. */
function fakeLinear(answer: (operation: string, variables: Record<string, unknown>) => unknown) {
	const asked: Asked[] = [];
	const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Asked;
		asked.push({ ...body, authorization: new Headers(init?.headers).get("Authorization") });
		const operation = /query (\w+)/.exec(body.query)?.[1] ?? "";
		return new Response(JSON.stringify({ data: answer(operation, body.variables) }));
	}) as typeof globalThis.fetch;
	return { fetch, asked };
}

const team = { id: "team-1", key: "ENG", name: "Engineering" };

function issue(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		identifier: `ENG-${id}`,
		title: `Issue ${id}`,
		description: null,
		priority: 0,
		estimate: null,
		dueDate: null,
		createdAt: "2024-01-01T00:00:00.000Z",
		url: `https://linear.app/acme/issue/ENG-${id}`,
		state: { name: "Backlog", type: "backlog" },
		assignee: null,
		project: null,
		parent: null,
		labels: { nodes: [] },
		relations: { nodes: [] },
		...overrides,
	};
}

function page(nodes: unknown[], endCursor: string | null = null) {
	return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

describe("listLinearTeams", () => {
	it("sends the key as it is, as Linear asks for personal keys", async () => {
		const linear = fakeLinear(() => ({ teams: page([team]) }));
		expect(await listLinearTeams(" lin_api_key ", { fetch: linear.fetch })).toEqual([team]);
		expect(linear.asked[0]?.authorization).toBe("lin_api_key");
	});
});

describe("readLinearImport", () => {
	it("reads a team's issues and comments page by page", async () => {
		const linear = fakeLinear((operation, variables) => {
			expect(variables.team).toBe("team-1");
			if (operation === "Issues") {
				return variables.after === "c1"
					? {
							issues: page([
								issue("2", {
									state: { name: "In Review", type: "started" },
									parent: { id: "1" },
									priority: 4,
									estimate: 2.5,
								}),
								issue("3", {
									state: { name: "Duplicate", type: "duplicate" },
									relations: {
										nodes: [
											{ id: "r2", type: "duplicate", relatedIssue: { id: "1" } },
											// Linear's guess, and a second relation between the same two issues.
											{ id: "r3", type: "similar", relatedIssue: { id: "2" } },
											{ id: "r4", type: "related", relatedIssue: { id: "1" } },
										],
									},
								}),
							]),
						}
					: {
							issues: page(
								[
									issue("1", {
										description: "Ship **it**",
										priority: 1,
										estimate: 3,
										dueDate: "2024-02-01",
										state: { name: "Doing", type: "started" },
										assignee: { name: "Ada", email: "ada@example.test" },
										project: { name: "Launch" },
										labels: { nodes: [{ name: "Bug", color: "#EB5757" }] },
										relations: {
											nodes: [{ id: "r1", type: "blocks", relatedIssue: { id: "2" } }],
										},
									}),
								],
								"c1",
							),
						};
			}
			if (operation === "Projects") {
				return {
					team: {
						projects: page([
							{
								name: "Launch",
								description: "Ship v1",
								content: "## Scope\n\nEverything",
								targetDate: "2024-03-01",
								status: { type: "started" },
								lead: { name: "Ada", email: "ada@example.test" },
								projectUpdates: {
									nodes: [
										{
											id: "u1",
											body: "Slipping a week",
											health: "atRisk",
											createdAt: "2024-01-03T00:00:00.000Z",
											user: { name: "Ada" },
										},
									],
								},
							},
							{
								name: "Someday",
								description: "",
								content: null,
								targetDate: null,
								status: { type: "backlog" },
								lead: null,
								projectUpdates: { nodes: [] },
							},
						]),
					},
				};
			}
			return {
				comments: page([
					{
						id: "k1",
						body: "Looks good",
						createdAt: "2024-01-02T00:00:00.000Z",
						issue: { id: "1" },
						user: null,
						botActor: { name: "GitHub" },
						externalUser: null,
					},
					{
						id: "k2",
						body: "On a project update",
						createdAt: "2024-01-02T00:00:00.000Z",
						issue: null,
						user: { name: "Ada" },
						botActor: null,
						externalUser: null,
					},
				]),
			};
		});
		const source = await readLinearImport("key", team, { fetch: linear.fetch });

		expect(linear.asked.map((ask) => /query (\w+)/.exec(ask.query)?.[1])).toEqual([
			"Issues",
			"Issues",
			"Comments",
			"Projects",
		]);
		expect(source.name).toBe("Linear");
		expect(source.labelColors?.get("Bug")).toBe("#EB5757");
		expect(source.issues).toMatchObject([
			{
				sourceId: "linear:1",
				title: "Issue 1",
				description: "Ship **it**",
				status: { name: "Doing", category: "started" },
				priority: 1,
				labels: ["Bug"],
				assignee: { name: "Ada", email: "ada@example.test" },
				project: "Launch",
				dueDate: "2024-02-01",
				estimate: 3,
				reference: "ENG-1",
				url: "https://linear.app/acme/issue/ENG-1",
				createdAt: Date.UTC(2024, 0, 1),
				comments: [{ sourceId: "linear:comment:k1", body: "Looks good", author: "GitHub" }],
			},
			{
				status: { name: "In Review", category: "started" },
				priority: 4,
				parentSourceId: "linear:1",
				comments: [],
			},
			{ status: { name: "Duplicate", category: "canceled" } },
		]);
		expect(source.relations).toEqual([
			{
				sourceId: "linear:relation:r1",
				type: "blocks",
				issueSourceId: "linear:1",
				relatedIssueSourceId: "linear:2",
			},
			{
				sourceId: "linear:relation:r2",
				type: "duplicate",
				issueSourceId: "linear:3",
				relatedIssueSourceId: "linear:1",
			},
		]);
		expect(source.projects).toEqual([
			{
				name: "Launch",
				description: "Ship v1\n\n## Scope\n\nEverything",
				status: "started",
				lead: { name: "Ada", email: "ada@example.test" },
				targetDate: "2024-03-01",
				updates: [
					{
						sourceId: "linear:project-update:u1",
						health: "at_risk",
						body: "Slipping a week",
						author: "Ada",
						createdAt: Date.UTC(2024, 0, 3),
					},
				],
			},
			{
				name: "Someday",
				description: null,
				status: "planned",
				lead: null,
				targetDate: null,
				updates: [],
			},
		]);
	});

	it("explains a key Linear does not accept, and its limits", async () => {
		const answering = (status: number, body: unknown) =>
			(async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
		await expect(
			listLinearTeams("bad", {
				fetch: answering(401, { errors: [{ message: "Authentication required" }] }),
			}),
		).rejects.toThrow("did not accept the API key");
		await expect(
			readLinearImport("key", team, {
				fetch: answering(400, {
					errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }],
				}),
			}),
		).rejects.toThrow("limit on requests was reached");
		await expect(
			listLinearTeams("key", { fetch: answering(200, { errors: [{ message: "Bad query" }] }) }),
		).rejects.toThrow("Linear answered: Bad query");
	});
});
