import type {
	Comment,
	Issue,
	Label,
	Member,
	Mutation,
	MutationInput,
	Project,
	Proposal,
	Team,
} from "@gateweave/track-protocol";
import { mutationSchema } from "@gateweave/track-protocol";
import type { IssueQuery, MemberProfile, MutateResult } from "@gateweave/track-sync-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createTrackServer, type TrackAccess, type WorkspaceAccess } from "./tools";

const me: MemberProfile = {
	id: "user-me",
	name: "Maya",
	email: "maya@example.com",
	image: null,
	role: "owner",
};
const sam: Member = {
	id: "user-sam",
	name: "Sam",
	email: "sam@example.com",
	image: null,
	role: "member",
	proposes: [],
	removedAt: null,
};
const team: Team = { id: "team-eng", key: "ENG", name: "Engineering", createdAt: 0, updatedAt: 0 };

/**
 * A one-workspace stand-in for the gateway and Durable Object. It applies mutations naively; the
 * real validation is tested in sync-server. Here the subject is how tools turn agent input into
 * reads and mutations, and results back into answers.
 */
class FakeWorkspace implements WorkspaceAccess {
	readonly slug = "acme";
	me: MemberProfile = me;
	teams: Team[] = [team];
	issues_: Issue[] = [];
	labels: Label[] = [];
	comments_: Comment[] = [];
	mutations: Mutation[] = [];
	nextResult: MutateResult | null = null;
	/** What the server would turn into proposals rather than make, as for an agent set so. */
	proposing = new Set<"status" | "assigneeId" | "labels" | "projectId">();
	projects: Project[] = [];
	proposals_: Proposal[] = [];
	#version = 10;

	async directory() {
		return {
			teams: this.teams,
			labels: this.labels,
			projects: this.projects,
			members: [{ ...me, proposes: [], removedAt: null }, sam],
		};
	}
	async issues(query: IssueQuery) {
		return this.issues_
			.filter((issue) => query.assigneeId === undefined || issue.assigneeId === query.assigneeId)
			.filter((issue) => !query.statuses || query.statuses.includes(issue.status))
			.filter((issue) => query.labelId === undefined || issue.labelIds.includes(query.labelId))
			.filter((issue) => query.projectId === undefined || issue.projectId === query.projectId)
			.slice(0, query.limit);
	}
	async issue(id: string) {
		return this.issues_.find((issue) => issue.id === id) ?? null;
	}
	async issueByKey(teamKey: string, number: number) {
		if (teamKey !== team.key) return null;
		return this.issues_.find((issue) => issue.number === number) ?? null;
	}
	async comments(issueId: string) {
		return this.comments_.filter((comment) => comment.issueId === issueId);
	}
	async proposals(issueId: string) {
		return this.proposals_.filter((proposal) => proposal.issueId === issueId);
	}
	async lastSortOrder() {
		return (
			this.issues_
				.map((issue) => issue.sortOrder)
				.sort()
				.at(-1) ?? null
		);
	}
	async mutate(input: MutationInput): Promise<MutateResult> {
		const mutation = mutationSchema.parse(input);
		this.mutations.push(mutation);
		if (this.nextResult) return this.nextResult;
		// The rules the server applies to teams, so refusals come back as it would send them.
		if (mutation.name === "team.create") {
			if (this.me.role === "member") {
				return {
					ok: false,
					reason: "forbidden",
					message: "Only workspace admins can manage teams",
				};
			}
			if (this.teams.some((other) => other.key === mutation.args.key)) {
				return {
					ok: false,
					reason: "conflict",
					message: `Team key ${mutation.args.key} is already in use`,
				};
			}
		}
		const version = ++this.#version;
		const proposed: Proposal[] = [];
		const propose = (issueId: string, change: Proposal["change"]) => {
			const proposal = {
				id: `p-${version}`,
				issueId,
				agentId: me.id,
				change,
				createdAt: 0,
				updatedAt: 0,
			};
			proposed.push(proposal);
			this.proposals_.push(proposal);
		};
		if (mutation.name === "issue.create") {
			const args = mutation.args;
			this.issues_.push({
				...{ ...args },
				number: this.issues_.length + 1,
				creatorId: me.id,
				version,
				createdAt: Date.UTC(2026, 9, 27),
				updatedAt: Date.UTC(2026, 9, 27),
			});
		} else if (mutation.name === "issue.update") {
			const { id, patch } = mutation.args;
			const { status, assigneeId, projectId, ...rest } = patch;
			const issue = this.issues_.find((issue) => issue.id === id);
			if (status !== undefined && this.proposing.has("status")) {
				propose(id, { type: "status", to: status });
			} else if (status !== undefined) {
				Object.assign(rest, { status });
			}
			if (assigneeId !== undefined && this.proposing.has("assigneeId")) {
				propose(id, { type: "assignee", to: assigneeId });
			} else if (assigneeId !== undefined) {
				Object.assign(rest, { assigneeId });
			}
			if (projectId !== undefined && this.proposing.has("projectId")) {
				propose(id, { type: "project", to: projectId });
			} else if (projectId !== undefined) {
				Object.assign(rest, { projectId });
			}
			if (issue) Object.assign(issue, rest, { version });
		} else if (mutation.name === "issue.addLabel" || mutation.name === "issue.removeLabel") {
			const { id, labelId } = mutation.args;
			const issue = this.issues_.find((issue) => issue.id === id);
			if (this.proposing.has("labels")) {
				propose(id, { type: "label", labelId, added: mutation.name === "issue.addLabel" });
			} else if (issue) {
				const rest = issue.labelIds.filter((other) => other !== labelId);
				issue.labelIds = mutation.name === "issue.addLabel" ? [...rest, labelId] : rest;
				issue.version = version;
			}
		} else if (mutation.name === "label.create") {
			this.labels.push({ ...mutation.args, createdAt: 0, updatedAt: 0 });
		} else if (mutation.name === "team.create") {
			this.teams.push({ ...mutation.args, createdAt: 0, updatedAt: 0 });
		} else if (mutation.name === "comment.create") {
			const at = Date.UTC(2026, 9, 28);
			this.comments_.push({ ...mutation.args, authorId: me.id, createdAt: at, updatedAt: at });
		}
		return { ok: true, version, proposed };
	}
}

let workspace: FakeWorkspace;
let client: Client;

beforeEach(async () => {
	workspace = new FakeWorkspace();
	const access: TrackAccess = {
		origin: "https://track.example.com",
		workspaces: async () => [{ slug: "acme", name: "Acme", role: "owner" }],
		workspace: async (slug) => (slug === workspace.slug ? workspace : null),
	};
	const handler = createMcpHandler(() => createTrackServer(access));
	client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://track.example.com/mcp"), {
			fetch: (url, init) => handler.fetch(new Request(url, init)),
		}),
	);
});

async function call(name: string, args: Record<string, unknown> = {}) {
	return client.callTool({ name, arguments: args });
}

async function created(args: Record<string, unknown>) {
	const result = await call("create_issue", { workspace: "acme", team: "ENG", ...args });
	expect(result.isError).toBeFalsy();
	return result.structuredContent as Record<string, unknown>;
}

describe("Track MCP tools", () => {
	it("lists every tool", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"add_comment",
			"create_issue",
			"create_label",
			"create_team",
			"get_issue",
			"get_workspace",
			"list_workspaces",
			"search_issues",
			"update_issue",
		]);
	});

	it("lets results grow without breaking clients that cached the output schemas", async () => {
		const { tools } = await client.listTools();
		const closed: string[] = [];
		function walk(schema: unknown, path: string) {
			if (typeof schema !== "object" || schema === null) return;
			for (const [key, value] of Object.entries(schema)) {
				if (key === "additionalProperties" && value === false) closed.push(path);
				walk(value, `${path}.${key}`);
			}
		}
		for (const tool of tools) walk(tool.outputSchema, tool.name);
		expect(closed).toEqual([]);
	});

	it("lists workspaces, teams and members", async () => {
		expect((await call("list_workspaces")).structuredContent).toEqual({
			workspaces: [{ slug: "acme", name: "Acme", role: "owner" }],
		});
		expect((await call("get_workspace", { workspace: "acme" })).structuredContent).toEqual({
			teams: [{ key: "ENG", name: "Engineering" }],
			labels: [],
			projects: [],
			members: [
				{ id: me.id, name: "Maya", email: "maya@example.com", role: "owner" },
				{ id: sam.id, name: "Sam", email: "sam@example.com", role: "member" },
			],
		});
	});

	it("answers for an unknown workspace as for a missing one", async () => {
		const result = await call("get_workspace", { workspace: "someone-elses" });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: 'Workspace "someone-elses" not found. See list_workspaces.' },
		]);
	});

	it("creates an issue after every other one, resolving names to ids", async () => {
		await created({ title: "First" });
		const issue = await created({
			title: "Second",
			description: "Details",
			status: "todo",
			priority: "high",
			assignee: "SAM@example.com",
		});

		const mutation = workspace.mutations.at(-1);
		expect(mutation?.name).toBe("issue.create");
		if (mutation?.name !== "issue.create") return;
		expect(mutation.args).toMatchObject({
			teamId: team.id,
			status: "todo",
			priority: 2,
			assigneeId: sam.id,
		});
		expect(mutation.args.sortOrder > (workspace.issues_[0]?.sortOrder ?? "")).toBe(true);
		expect(issue).toMatchObject({
			key: "ENG-2",
			title: "Second",
			status: "todo",
			priority: "high",
			assignee: "sam@example.com",
			creator: "maya@example.com",
			description: "Details",
			url: "https://track.example.com/acme/issue/ENG-2",
		});
	});

	it("rejects unknown teams and assignees without writing", async () => {
		const team = await call("create_issue", { workspace: "acme", team: "OPS", title: "Nope" });
		const assignee = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Nope",
			assignee: "nobody@example.com",
		});
		expect(team.isError).toBe(true);
		expect(team.content).toEqual([{ type: "text", text: 'No team with key "OPS". Teams: ENG.' }]);
		expect(assignee.isError).toBe(true);
		expect(workspace.mutations).toEqual([]);
	});

	it("updates only the given fields, from the version it just read", async () => {
		await created({ title: "Ship it", priority: "low" });
		const before = workspace.issues_[0];

		const result = await call("update_issue", {
			workspace: "acme",
			key: "eng-1",
			status: "in_progress",
			assignee: "me",
		});

		expect(result.structuredContent).toMatchObject({
			status: "in_progress",
			priority: "low",
			assignee: "maya@example.com",
		});
		expect(result.structuredContent).not.toHaveProperty("proposed");
		expect(workspace.mutations.at(-1)).toEqual({
			name: "issue.update",
			args: {
				id: before?.id,
				baseVersion: 11,
				patch: { status: "in_progress", assigneeId: me.id },
			},
		});
	});

	it("reports conflicts and rejections as tool errors", async () => {
		await created({ title: "Contested" });
		workspace.nextResult = { ok: false, reason: "conflict", message: "Conflict" };

		const result = await call("update_issue", { workspace: "acme", key: "ENG-1", title: "Mine" });

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Someone changed the same fields a moment ago. Read the issue again and retry.",
			},
		]);
	});

	it("says what an agent proposed instead of making, and shows what waits on the issue", async () => {
		await created({ title: "Triage me" });
		workspace.labels.push({
			id: "l-bug",
			name: "Bug",
			color: "#e5484d",
			createdAt: 0,
			updatedAt: 0,
		});
		workspace.proposing = new Set(["status", "assigneeId", "labels"]);

		const updated = await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			status: "done",
			priority: "high",
			assignee: "sam@example.com",
			add_labels: ["Bug"],
		});
		const read = await call("get_issue", { workspace: "acme", key: "ENG-1" });

		expect(updated.structuredContent).toMatchObject({
			status: "backlog",
			priority: "high",
			assignee: null,
			labels: [],
			proposed: [
				{ change: "status", to: "done" },
				{ change: "assignee", to: "sam@example.com" },
				{ change: "add_label", to: "Bug" },
			],
		});
		expect(read.structuredContent).toMatchObject({
			proposals: [
				{ change: "status", to: "done", by: "maya@example.com" },
				{ change: "assignee", to: "sam@example.com", by: "maya@example.com" },
				{ change: "add_label", to: "Bug", by: "maya@example.com" },
			],
		});
	});

	it("refuses an update that changes nothing", async () => {
		await created({ title: "Still" });
		const result = await call("update_issue", { workspace: "acme", key: "ENG-1" });
		expect(result.isError).toBe(true);
		expect(workspace.mutations).toHaveLength(1);
	});

	it("searches by status and assignee", async () => {
		await created({ title: "Mine", assignee: "me", status: "todo" });
		await created({ title: "Unassigned", status: "todo" });
		await created({ title: "Done", assignee: "me", status: "done" });

		const result = await call("search_issues", {
			workspace: "acme",
			assignee: "me",
			status: ["todo", "in_progress"],
		});

		expect(result.structuredContent).toMatchObject({ issues: [{ key: "ENG-1", title: "Mine" }] });
	});

	it("reads an issue by key, and says when there is none", async () => {
		await created({ title: "Readable", description: "Body" });

		const found = await call("get_issue", { workspace: "acme", key: "ENG-1" });
		const missing = await call("get_issue", { workspace: "acme", key: "ENG-9" });
		const malformed = await call("get_issue", { workspace: "acme", key: "not a key" });

		expect(found.structuredContent).toMatchObject({
			key: "ENG-1",
			description: "Body",
			proposals: [],
		});
		expect(missing.content).toEqual([{ type: "text", text: "Issue ENG-9 not found." }]);
		expect(malformed.isError).toBe(true);
	});

	it("comments on an issue, and reads comments along with it", async () => {
		await created({ title: "Discuss" });
		workspace.comments_.push({
			id: "comment-sam",
			issueId: workspace.issues_[0]?.id ?? "",
			authorId: sam.id,
			body: "First",
			createdAt: Date.UTC(2026, 9, 27),
			updatedAt: Date.UTC(2026, 9, 28),
		});

		const added = await call("add_comment", {
			workspace: "acme",
			key: "ENG-1",
			body: "  Second, from an agent  ",
		});
		const read = await call("get_issue", { workspace: "acme", key: "ENG-1" });
		const missing = await call("add_comment", { workspace: "acme", key: "ENG-9", body: "Hi" });

		expect(added.structuredContent).toEqual({
			author: "maya@example.com",
			body: "Second, from an agent",
			createdAt: "2026-10-28T00:00:00.000Z",
			edited: false,
		});
		expect(read.structuredContent).toMatchObject({
			key: "ENG-1",
			comments: [
				{ author: "sam@example.com", body: "First", edited: true },
				{ author: "maya@example.com", body: "Second, from an agent", edited: false },
			],
		});
		expect(missing.isError).toBe(true);
		expect(workspace.mutations.filter((m) => m.name === "comment.create")).toHaveLength(1);
	});

	it("creates labels, with a color picked from the name unless given", async () => {
		const picked = await call("create_label", { workspace: "acme", name: "Bug" });
		const given = await call("create_label", { workspace: "acme", name: "Docs", color: "#0090ff" });
		const duplicate = await call("create_label", { workspace: "acme", name: "bug" });

		expect(picked.structuredContent).toEqual({ name: "Bug", color: expect.stringMatching(/^#/) });
		expect(given.structuredContent).toEqual({ name: "Docs", color: "#0090ff" });
		expect(duplicate.isError).toBe(true);
		expect(workspace.mutations.filter((m) => m.name === "label.create")).toHaveLength(2);
	});

	it("creates teams for an admin, deriving the key from the name unless given", async () => {
		const derived = await call("create_team", { workspace: "acme", name: "Platform Engineering" });
		const given = await call("create_team", { workspace: "acme", name: "Design", key: "des" });

		expect(derived.structuredContent).toEqual({ key: "PE", name: "Platform Engineering" });
		expect(given.structuredContent).toEqual({ key: "DES", name: "Design" });
		expect((await call("get_workspace", { workspace: "acme" })).structuredContent).toMatchObject({
			teams: [
				{ key: "ENG", name: "Engineering" },
				{ key: "PE", name: "Platform Engineering" },
				{ key: "DES", name: "Design" },
			],
		});
		const issue = await call("create_issue", { workspace: "acme", team: "pe", title: "First" });
		expect(issue.structuredContent).toMatchObject({ key: "PE-1" });
	});

	it("passes a plain member's refusal on as a tool error, without a team", async () => {
		workspace.me = { ...me, role: "member" };
		const result = await call("create_team", { workspace: "acme", name: "Ops" });

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: "Only workspace admins can manage teams" },
		]);
		expect((await call("get_workspace", { workspace: "acme" })).structuredContent).toMatchObject({
			teams: [{ key: "ENG" }],
		});
	});

	it("refuses a taken or malformed team key, and a name with no key to derive", async () => {
		const taken = await call("create_team", { workspace: "acme", name: "Again", key: "eng" });
		const malformed = await call("create_team", { workspace: "acme", name: "Ops", key: "1OPS" });
		const underivable = await call("create_team", { workspace: "acme", name: "!!!" });

		expect(taken.isError).toBe(true);
		expect(taken.content).toEqual([{ type: "text", text: "Team key ENG is already in use." }]);
		expect(malformed.isError).toBe(true);
		expect(malformed.content).toEqual([
			{ type: "text", text: "1-7 uppercase letters or digits, starting with a letter" },
		]);
		expect(underivable.isError).toBe(true);
		// Only the taken key reached the server; the malformed ones were refused before any write.
		expect(workspace.mutations.map((m) => m.name)).toEqual(["team.create"]);
	});

	it("puts issues in projects by name or id, and finds them by project", async () => {
		workspace.projects.push(
			{
				id: "p-launch",
				name: "Public launch",
				description: null,
				status: "started",
				leadId: null,
				targetDate: null,
				createdAt: 0,
				updatedAt: 0,
			},
			{
				id: "p-docs",
				name: "Docs",
				description: null,
				status: "planned",
				leadId: null,
				targetDate: null,
				createdAt: 0,
				updatedAt: 0,
			},
		);

		const listed = await call("get_workspace", { workspace: "acme" });
		const first = await created({ title: "Announce", project: "PUBLIC LAUNCH" });
		await created({ title: "Write guides", project: "p-docs" });
		await created({ title: "Loose" });
		const found = await call("search_issues", { workspace: "acme", project: "public launch" });
		const moved = await call("update_issue", { workspace: "acme", key: "ENG-3", project: "Docs" });
		const cleared = await call("update_issue", { workspace: "acme", key: "ENG-1", project: null });
		const unchanged = await call("update_issue", {
			workspace: "acme",
			key: "ENG-3",
			title: "Renamed",
		});

		expect(listed.structuredContent).toMatchObject({
			projects: [
				{ id: "p-launch", name: "Public launch", status: "started" },
				{ id: "p-docs", name: "Docs", status: "planned" },
			],
		});
		expect(first).toMatchObject({ key: "ENG-1", project: "Public launch" });
		expect(workspace.issues_.map((issue) => issue.projectId)).toEqual([null, "p-docs", "p-docs"]);
		expect(found.structuredContent).toMatchObject({ issues: [{ key: "ENG-1" }] });
		expect(moved.structuredContent).toMatchObject({ key: "ENG-3", project: "Docs" });
		expect(cleared.structuredContent).toMatchObject({ key: "ENG-1", project: null });
		// Leaving the project out leaves it where it was.
		expect(unchanged.structuredContent).toMatchObject({ key: "ENG-3", project: "Docs" });
		const patch = workspace.mutations.find(
			(m) => m.name === "issue.update" && m.args.patch.projectId === null,
		);
		expect(patch).toBeDefined();
	});

	it("refuses an unknown project without writing", async () => {
		workspace.projects.push({
			id: "p-docs",
			name: "Docs",
			description: null,
			status: "planned",
			leadId: null,
			targetDate: null,
			createdAt: 0,
			updatedAt: 0,
		});
		await created({ title: "Something" });

		const create = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Nope",
			project: "Launch",
		});
		const update = await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			project: "Launch",
		});
		const search = await call("search_issues", { workspace: "acme", project: "Launch" });

		const text = [
			{ type: "text", text: 'No project "Launch". Projects: Docs. See get_workspace.' },
		];
		for (const result of [create, update, search]) {
			expect(result.isError).toBe(true);
			expect(result.content).toEqual(text);
		}
		expect(workspace.mutations.map((m) => m.name)).toEqual(["issue.create"]);
	});

	it("offers no way to create a project", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).filter((name) => name.includes("project"))).toEqual([]);
	});

	it("says when an agent proposed a project instead of setting it", async () => {
		workspace.projects.push({
			id: "p-docs",
			name: "Docs",
			description: null,
			status: "planned",
			leadId: null,
			targetDate: null,
			createdAt: 0,
			updatedAt: 0,
		});
		await created({ title: "Triage me" });
		workspace.proposing = new Set(["projectId"]);

		const updated = await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			project: "Docs",
		});
		const read = await call("get_issue", { workspace: "acme", key: "ENG-1" });

		expect(updated.structuredContent).toMatchObject({
			project: null,
			proposed: [{ change: "project", to: "Docs" }],
		});
		expect(read.structuredContent).toMatchObject({
			proposals: [{ change: "project", to: "Docs" }],
		});
	});

	it("labels issues by name, and finds them by label", async () => {
		await call("create_label", { workspace: "acme", name: "Bug" });
		await call("create_label", { workspace: "acme", name: "Docs" });
		const issue = await created({ title: "Broken link", labels: ["bug"] });
		await created({ title: "Unlabeled" });

		const updated = await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			add_labels: ["Docs"],
			remove_labels: ["Bug"],
		});
		const found = await call("search_issues", { workspace: "acme", label: "docs" });
		const unknown = await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			add_labels: ["Nope"],
		});

		expect(issue).toMatchObject({ key: "ENG-1", labels: ["Bug"] });
		expect(updated.structuredContent).toMatchObject({ labels: ["Docs"] });
		// Label changes are their own mutations, never a patch that could conflict.
		expect(workspace.mutations.map((m) => m.name)).not.toContain("issue.update");
		expect(found.structuredContent).toMatchObject({ issues: [{ key: "ENG-1" }] });
		expect(unknown.content).toEqual([
			{ type: "text", text: 'No label "Nope". Labels: Bug, Docs. Make one with create_label.' },
		]);
	});
});
