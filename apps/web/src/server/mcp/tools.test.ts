import type {
	Comment,
	Issue,
	Label,
	Member,
	Mutation,
	MutationInput,
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
	readonly me = me;
	issues_: Issue[] = [];
	labels: Label[] = [];
	comments_: Comment[] = [];
	mutations: Mutation[] = [];
	nextResult: MutateResult | null = null;
	#version = 10;

	async directory() {
		return { teams: [team], labels: this.labels, members: [{ ...me, removedAt: null }, sam] };
	}
	async issues(query: IssueQuery) {
		return this.issues_
			.filter((issue) => query.assigneeId === undefined || issue.assigneeId === query.assigneeId)
			.filter((issue) => !query.statuses || query.statuses.includes(issue.status))
			.filter((issue) => query.labelId === undefined || issue.labelIds.includes(query.labelId))
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
		const version = ++this.#version;
		if (mutation.name === "issue.create") {
			const { id, teamId, title, description, status, priority, assigneeId, labelIds, sortOrder } =
				mutation.args;
			this.issues_.push({
				...{ id, teamId, title, description, status, priority, assigneeId, labelIds, sortOrder },
				number: this.issues_.length + 1,
				creatorId: me.id,
				version,
				createdAt: Date.UTC(2026, 9, 27),
				updatedAt: Date.UTC(2026, 9, 27),
			});
		} else if (mutation.name === "issue.update") {
			const issue = this.issues_.find((issue) => issue.id === mutation.args.id);
			if (issue) Object.assign(issue, mutation.args.patch, { version });
		} else if (mutation.name === "issue.addLabel" || mutation.name === "issue.removeLabel") {
			const { id, labelId } = mutation.args;
			const issue = this.issues_.find((issue) => issue.id === id);
			if (issue) {
				const rest = issue.labelIds.filter((other) => other !== labelId);
				issue.labelIds = mutation.name === "issue.addLabel" ? [...rest, labelId] : rest;
				issue.version = version;
			}
		} else if (mutation.name === "label.create") {
			this.labels.push({ ...mutation.args, createdAt: 0, updatedAt: 0 });
		} else if (mutation.name === "comment.create") {
			const at = Date.UTC(2026, 9, 28);
			this.comments_.push({ ...mutation.args, authorId: me.id, createdAt: at, updatedAt: at });
		}
		return { ok: true, version };
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

		expect(found.structuredContent).toMatchObject({ key: "ENG-1", description: "Body" });
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
