import type {
	Activity,
	Comment,
	Cycle,
	Issue,
	IssueRelation,
	IssueTemplate,
	Label,
	Member,
	Mutation,
	MutationInput,
	Project,
	ProjectUpdate,
	Proposal,
	PullRequest,
	Team,
	WorkflowStatus,
} from "@gateweave/track-protocol";
import {
	addDays,
	dayIn,
	defaultStatuses,
	firstStatus,
	INTAKE_EMAIL_ACTOR_ID,
	mutationSchema,
} from "@gateweave/track-protocol";
import type {
	IssueQuery,
	MemberProfile,
	MutateResult,
	PanelView,
} from "@gateweave/track-sync-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { search } from "#/lib/search";
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
const team: Team = {
	id: "team-eng",
	key: "ENG",
	name: "Engineering",
	cycles: null,
	archiveAfterMonths: null,
	closeAfterMonths: null,
	intakeFormKey: null,
	intakeEmailKey: null,
	intakeFollowers: [],
	createdAt: 0,
	updatedAt: 0,
};

/**
 * A one-workspace stand-in for the gateway and Durable Object. It applies mutations naively; the
 * real validation is tested in sync-server. Here the subject is how tools turn agent input into
 * reads and mutations, and results back into answers.
 */
class FakeWorkspace implements WorkspaceAccess {
	readonly slug = "acme";
	openPanel = vi.fn<WorkspaceAccess["openPanel"]>();
	submitPosition = vi.fn<WorkspaceAccess["submitPosition"]>();
	getPanel = vi.fn<WorkspaceAccess["getPanel"]>();
	me: MemberProfile = me;
	teams: Team[] = [team];
	statuses: WorkflowStatus[] = defaultStatuses(team.id, 0);
	issues_: Issue[] = [];
	labels: Label[] = [];
	templates: IssueTemplate[] = [];
	comments_: Comment[] = [];
	activities_: Activity[] = [];
	mutations: Mutation[] = [];
	nextResult: MutateResult | null = null;
	/** What the server would turn into proposals rather than make, as for an agent set so. */
	proposing = new Set<"status" | "assigneeId" | "labels" | "projectId">();
	projects: Project[] = [];
	projectUpdates_: ProjectUpdate[] = [];
	proposals_: Proposal[] = [];
	relations_: IssueRelation[] = [];
	pullRequests_: PullRequest[] = [];
	cycles: Cycle[] = [];
	queries: IssueQuery[] = [];
	#version = 10;

	async directory() {
		return {
			teams: this.teams,
			statuses: this.statuses,
			labels: this.labels,
			projects: this.projects,
			cycles: this.cycles,
			members: [{ ...me, proposes: [], removedAt: null }, sam],
			templates: this.templates,
			projectHealth: Object.fromEntries(
				[...this.projectUpdates_]
					.sort((a, b) => a.createdAt - b.createdAt)
					.map((update) => [update.projectId, update.health]),
			),
		};
	}
	async projectUpdates(projectId: string) {
		return this.projectUpdates_
			.filter((update) => update.projectId === projectId)
			.sort((a, b) => b.createdAt - a.createdAt);
	}
	async issues(query: IssueQuery) {
		this.queries.push(query);
		return this.#findIssues(query);
	}
	async issuePage(query: IssueQuery) {
		this.queries.push(query);
		const rows = await this.#findIssues({ ...query, limit: query.limit + 1 });
		return {
			issues: rows.slice(0, query.limit),
			nextOffset: rows.length > query.limit ? (query.offset ?? 0) + query.limit : null,
		};
	}
	#findIssues(query: IssueQuery) {
		const filtered = this.issues_
			.filter((issue) => query.teamId === undefined || issue.teamId === query.teamId)
			.filter((issue) => query.assigneeId === undefined || issue.assigneeId === query.assigneeId)
			.filter((issue) => !query.statuses || query.statuses.includes(issue.status))
			.filter((issue) => query.labelId === undefined || issue.labelIds.includes(query.labelId))
			.filter((issue) => query.projectId === undefined || issue.projectId === query.projectId)
			.filter((issue) => query.parentId === undefined || issue.parentId === query.parentId)
			.filter((issue) => !query.cycleIds || query.cycleIds.includes(issue.cycleId ?? ""))
			.filter(
				(issue) => query.archived === undefined || (issue.archivedAt !== null) === query.archived,
			)
			.filter((issue) => query.intake === undefined || issue.intake === query.intake);
		const offset = query.offset ?? 0;
		if (query.text?.trim()) {
			const ids = new Set(filtered.map((issue) => issue.id));
			return search(
				{
					teams: new Map(this.teams.map((team) => [team.id, team])),
					issues: new Map(filtered.map((issue) => [issue.id, issue])),
					comments: new Map(
						this.comments_
							.filter((comment) => ids.has(comment.issueId))
							.map((comment) => [comment.id, comment]),
					),
				},
				query.text,
				offset + query.limit,
			)
				.slice(offset)
				.map((result) => result.issue as Issue);
		}
		return filtered.slice(offset, offset + query.limit);
	}
	async issue(id: string) {
		return this.issues_.find((issue) => issue.id === id) ?? null;
	}
	async issueByKey(teamKey: string, number: number) {
		if (teamKey !== team.key) return null;
		return this.issues_.find((issue) => issue.number === number) ?? null;
	}
	async insightSource(scope: { teamId: string } | { projectId: string }) {
		const issues = this.issues_.filter((issue) =>
			"teamId" in scope ? issue.teamId === scope.teamId : issue.projectId === scope.projectId,
		);
		const ids = new Set(issues.map((issue) => issue.id));
		return { issues, activities: this.activities_.filter((entry) => ids.has(entry.issueId)) };
	}
	async comments(issueId: string) {
		return this.comments_.filter((comment) => comment.issueId === issueId);
	}
	async proposals(issueId: string) {
		return this.proposals_.filter((proposal) => proposal.issueId === issueId);
	}
	async pullRequests(issueId: string) {
		return this.pullRequests_.filter((pullRequest) => pullRequest.issueIds.includes(issueId));
	}
	async relations(issueId: string) {
		return this.relations_.filter(
			(relation) => relation.issueId === issueId || relation.relatedIssueId === issueId,
		);
	}
	async lastSortOrder() {
		return (
			this.issues_
				.map((issue) => issue.sortOrder)
				.sort()
				.at(-1) ?? null
		);
	}
	uploads: { name: string; type: string; size: number }[] = [];
	keepsFiles = true;
	async uploadAddress(file: { name: string; type: string; size: number }) {
		this.uploads.push(file);
		if (!this.keepsFiles) return null;
		const path = `/api/files/w1/0000/${encodeURIComponent(file.name)}`;
		return {
			url: `https://track.example.com${path}?upload=token`,
			path,
			name: file.name,
			type: file.type,
			expiresAt: Date.UTC(2026, 10, 26, 10, 10),
		};
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
		// The rules the server applies to projects: people only, and a person leads.
		if (mutation.name === "project.create" || mutation.name === "project.update") {
			if (this.me.role === "agent") {
				return {
					ok: false,
					reason: "forbidden",
					message:
						mutation.name === "project.create"
							? "Agents cannot create projects"
							: "Agents cannot change projects",
				};
			}
			const leadId =
				mutation.name === "project.create" ? mutation.args.leadId : mutation.args.patch.leadId;
			if (leadId !== undefined && leadId !== null && leadId !== me.id && leadId !== sam.id) {
				return { ok: false, reason: "invalid", message: "Lead is not a person in this workspace" };
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
			const status =
				args.status ??
				firstStatus(this.statuses.filter((status) => status.teamId === args.teamId))?.key ??
				"backlog";
			this.issues_.push({
				...{ ...args },
				status,
				number: this.issues_.length + 1,
				creatorId: me.id,
				version,
				createdAt: Date.UTC(2026, 9, 27),
				updatedAt: Date.UTC(2026, 9, 27),
				archivedAt: null,
				intake: args.intake ?? false,
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
		} else if (mutation.name === "issue.archive") {
			const issue = this.issues_.find((issue) => issue.id === mutation.args.id);
			if (issue) Object.assign(issue, { archivedAt: mutation.args.archived ? 1 : null, version });
		} else if (mutation.name === "issue.accept" || mutation.name === "issue.decline") {
			// The rule the server applies: only people take a request out of intake, and an agent's
			// decision waits as a proposal.
			if (this.me.role === "agent") {
				propose(
					mutation.args.id,
					mutation.name === "issue.accept"
						? { type: "intake", accepted: true, status: mutation.args.status ?? null, reply: null }
						: {
								type: "intake",
								accepted: false,
								status: null,
								reply: mutation.args.reply?.body ?? null,
							},
				);
				return { ok: true, version, proposed };
			}
			const issue = this.issues_.find((issue) => issue.id === mutation.args.id);
			if (issue && mutation.name === "issue.accept") {
				Object.assign(issue, { intake: false, status: mutation.args.status ?? issue.status });
			} else if (issue) {
				Object.assign(issue, { intake: false, status: "canceled" });
			}
		} else if (mutation.name === "label.create") {
			this.labels.push({ ...mutation.args, createdAt: 0, updatedAt: 0 });
		} else if (mutation.name === "team.create") {
			this.teams.push({
				...mutation.args,
				cycles: null,
				archiveAfterMonths: null,
				closeAfterMonths: null,
				intakeFormKey: null,
				intakeEmailKey: null,
				intakeFollowers: [],
				createdAt: 0,
				updatedAt: 0,
			});
		} else if (mutation.name === "project.create") {
			this.projects.push({ ...mutation.args, createdAt: 0, updatedAt: 0 });
		} else if (mutation.name === "project.update") {
			const project = this.projects.find((project) => project.id === mutation.args.id);
			if (!project) return { ok: false, reason: "not_found", message: "Project not found" };
			Object.assign(project, mutation.args.patch);
		} else if (mutation.name === "relation.create") {
			const { issueId, relatedIssueId } = mutation.args;
			// One relation per pair, as on the server: a new one replaces it.
			this.relations_ = this.relations_.filter(
				(relation) =>
					![relation.issueId, relation.relatedIssueId].every(
						(id) => id === issueId || id === relatedIssueId,
					),
			);
			this.relations_.push({ ...mutation.args, creatorId: me.id, createdAt: version });
		} else if (mutation.name === "relation.delete") {
			this.relations_ = this.relations_.filter((relation) => relation.id !== mutation.args.id);
		} else if (mutation.name === "projectUpdate.create") {
			const at = Date.UTC(2026, 9, 28) + version;
			this.projectUpdates_.push({
				...mutation.args,
				authorId: me.id,
				createdAt: at,
				updatedAt: at,
			});
		} else if (mutation.name === "comment.create") {
			const at = Date.UTC(2026, 9, 28);
			this.comments_.push({ ...mutation.args, authorId: this.me.id, createdAt: at, updatedAt: at });
		} else if (mutation.name === "comment.update") {
			const comment = this.comments_.find((row) => row.id === mutation.args.id);
			if (!comment) return { ok: false, reason: "not_found", message: "Comment not found" };
			if (comment.authorId !== this.me.id) {
				return { ok: false, reason: "forbidden", message: "Only the author can edit a comment" };
			}
			comment.body = mutation.args.body;
			comment.updatedAt += 1;
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
	it("R34: the MCP tool list grants no source management", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"add_comment",
			"attach_file",
			"create_issue",
			"create_label",
			"create_project",
			"create_team",
			"get_insights",
			"get_issue",
			"get_panel",
			"get_workspace",
			"link_issues",
			"list_project_updates",
			"list_workspaces",
			"open_panel",
			"post_project_update",
			"search_issues",
			"submit_position",
			"triage_request",
			"unlink_issues",
			"update_comment",
			"update_issue",
			"update_project",
		]);
	});

	it("advertises closed input schemas for every tool", async () => {
		const { tools } = await client.listTools();
		for (const tool of tools) {
			expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
		}
	});

	it("hands out an upload address with the Markdown that shows the file", async () => {
		const image = await call("attach_file", {
			workspace: "acme",
			name: "shot.png",
			type: "image/png",
			size: 68,
		});
		expect(image.structuredContent).toEqual({
			name: "shot.png",
			type: "image/png",
			size: 68,
			uploadUrl: "https://track.example.com/api/files/w1/0000/shot.png?upload=token",
			method: "PUT",
			expiresAt: "2026-11-26T10:10:00.000Z",
			attachmentMarkdown: "![shot.png](/api/files/w1/0000/shot.png)",
		});
		const video = await call("attach_file", {
			workspace: "acme",
			name: "demo.mp4",
			type: "video/mp4",
			size: 1000,
		});
		expect(video.structuredContent).toMatchObject({
			attachmentMarkdown: "[demo.mp4](/api/files/w1/0000/demo.mp4)",
		});

		// A workspace the caller is not in reads as one that does not exist.
		const elsewhere = await call("attach_file", {
			workspace: "globex",
			name: "shot.png",
			type: "image/png",
			size: 68,
		});
		expect(elsewhere.content).toEqual([
			{ type: "text", text: 'Workspace "globex" not found. See list_workspaces.' },
		]);
		const tooLarge = await call("attach_file", {
			workspace: "acme",
			name: "big.mp4",
			type: "video/mp4",
			size: 25 * 1024 * 1024 + 1,
		});
		expect(tooLarge.isError).toBe(true);
		expect(workspace.uploads).toHaveLength(2);

		workspace.keepsFiles = false;
		const off = await call("attach_file", {
			workspace: "acme",
			name: "shot.png",
			type: "image/png",
			size: 68,
		});
		expect(off.content).toEqual([
			{ type: "text", text: "This Track does not keep attached files." },
		]);
	});

	it("refuses unknown search fields before reading issues and names the accepted fields", async () => {
		await created({ title: "Unrelated" });
		workspace.queries.length = 0;
		const result = await call("search_issues", { workspace: "acme", query: "Pinterest" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(result.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining('Unknown field "query". search_issues accepts:'),
			},
		]);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining('use "text"') });
		expect(workspace.queries).toEqual([]);
	});

	it("accepts MCP request metadata alongside strict tool arguments", async () => {
		const result = await client.callTool({
			name: "search_issues",
			arguments: { workspace: "acme", text: "light" },
			_meta: { progressToken: "search-progress" },
		});
		expect(result.isError).toBeFalsy();
		expect(workspace.queries).toHaveLength(1);
	});

	it("refuses unknown fields on other tools, including the no-argument tool", async () => {
		const extra = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Should not be created",
			unexpected: true,
		});
		expect(extra.isError).toBe(true);
		expect(extra.content[0]).toMatchObject({
			text: expect.stringContaining("create_issue accepts: workspace, team"),
		});
		expect(workspace.issues_).toEqual([]);
		const empty = await call("list_workspaces", { unexpected: true });
		expect(empty.isError).toBe(true);
		expect(empty.content[0]).toMatchObject({ text: expect.stringContaining("no fields") });
	});

	it("returns short write answers unless description is requested", async () => {
		const made = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Short",
			description: "Long body",
		});
		expect(made.structuredContent).toEqual({
			key: "ENG-1",
			title: "Short",
			status: "backlog",
			statusName: "Backlog",
			priority: "none",
			assignee: null,
			labels: [],
			project: null,
			url: "https://track.example.com/acme/issue/ENG-1",
			updatedAt: "2026-10-27T00:00:00.000Z",
			creator: "maya@example.com",
		});
		const changed = await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			title: "Shorter",
			include: ["description"],
		});
		expect(changed.structuredContent).toMatchObject({ title: "Shorter", description: "Long body" });
		const again = await call("update_issue", { workspace: "acme", key: "ENG-1", title: "Again" });
		expect(again.structuredContent).not.toHaveProperty("description");
		const included = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "With body",
			description: "Visible",
			include: ["description"],
		});
		expect(included.structuredContent).toMatchObject({ description: "Visible" });
	});

	it("passes text to a narrowing search and applies the limit to matches", async () => {
		await created({ title: "Şüpheli üye ışığı" });
		await created({ title: "Unrelated", description: "Şüpheli report" });
		await created({ title: "Unrelated again" });
		await call("add_comment", { workspace: "acme", key: "ENG-3", body: "Şüpheli note" });
		for (let n = 0; n < 50; n += 1) await created({ title: `Unrelated ${n}` });
		const found = await call("search_issues", { workspace: "acme", text: "supheli" });
		expect(
			(found.structuredContent as { issues: { key: string }[] }).issues.map((row) => row.key),
		).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
		expect(
			(await call("search_issues", { workspace: "acme", text: "supheli uye isigi" }))
				.structuredContent,
		).toMatchObject({ issues: [{ key: "ENG-1" }] });
		expect(
			(await call("search_issues", { workspace: "acme", text: "supheli", limit: 1 }))
				.structuredContent,
		).toMatchObject({ issues: [{ key: "ENG-1" }] });
		expect(workspace.queries.at(-1)).toMatchObject({ text: "supheli", limit: 1 });
	});

	it("pages search results with nextOffset and no skipped or repeated issues", async () => {
		for (let n = 1; n <= 5; n += 1) await created({ title: `Page me ${n}` });
		const read = async (offset?: number) => {
			const result = await call("search_issues", {
				workspace: "acme",
				text: "page",
				limit: 2,
				...(offset === undefined ? {} : { offset }),
			});
			return result.structuredContent as { issues: { key: string }[]; nextOffset: number | null };
		};
		const first = await read();
		expect(first.issues).toHaveLength(2);
		expect(first.nextOffset).toBe(2);
		const second = await read(first.nextOffset ?? 0);
		expect(second.issues).toHaveLength(2);
		expect(second.nextOffset).toBe(4);
		const third = await read(second.nextOffset ?? 0);
		expect(third.issues).toHaveLength(1);
		expect(third.nextOffset).toBeNull();
		const keys = [...first.issues, ...second.issues, ...third.issues].map((issue) => issue.key);
		expect(new Set(keys).size).toBe(5);
		expect(keys).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]);
	});

	it("edits only the caller's comment, including for an agent", async () => {
		await created({ title: "Discussion" });
		const added = await call("add_comment", { workspace: "acme", key: "ENG-1", body: "Before" });
		const id = (added.structuredContent as { id: string }).id;
		const changed = await call("update_comment", {
			workspace: "acme",
			key: "ENG-1",
			id,
			body: "After",
		});
		expect(changed.structuredContent).toMatchObject({ id, body: "After", edited: true });
		workspace.me = { ...me, id: "agent-bot", role: "agent" };
		const agent = await call("update_comment", {
			workspace: "acme",
			key: "ENG-1",
			id,
			body: "Agent",
		});
		expect(agent.isError).toBe(true);
		const ownAgent = await call("add_comment", {
			workspace: "acme",
			key: "ENG-1",
			body: "Agent before",
		});
		const ownAgentId = (ownAgent.structuredContent as { id: string }).id;
		expect(
			(
				await call("update_comment", {
					workspace: "acme",
					key: "ENG-1",
					id: ownAgentId,
					body: "Agent after",
				})
			).structuredContent,
		).toMatchObject({ body: "Agent after" });
		workspace.me = me;
		workspace.comments_.push({
			id: "someone-else",
			issueId: workspace.issues_[0]?.id ?? "",
			authorId: sam.id,
			body: "Private",
			createdAt: 1,
			updatedAt: 1,
		});
		expect(
			(
				await call("update_comment", {
					workspace: "acme",
					key: "ENG-1",
					id: "someone-else",
					body: "No",
				})
			).isError,
		).toBe(true);
		expect(
			(await call("update_comment", { workspace: "other", key: "ENG-1", id, body: "No" })).isError,
		).toBe(true);
		expect(
			(await call("update_comment", { workspace: "acme", key: "ENG-1", id, body: " " })).isError,
		).toBe(true);
		expect(
			(
				await call("update_comment", {
					workspace: "acme",
					key: "ENG-1",
					id,
					body: "x".repeat(100_001),
				})
			).isError,
		).toBe(true);
		const tools = (await client.listTools()).tools;
		expect(tools.find((tool) => tool.name === "update_comment")?.description).toContain(
			"Only its author",
		);
	});

	it("reads a team's or a project's insights, with keys, names and emails", async () => {
		const day = 24 * 60 * 60 * 1000;
		const now = Date.now();
		workspace.labels.push({
			id: "l-bug",
			name: "Bug",
			color: "#e5484d",
			createdAt: 0,
			updatedAt: 0,
		});
		workspace.projects.push({
			id: "p-docs",
			name: "Docs",
			description: null,
			status: "started",
			leadId: null,
			targetDate: null,
			createdAt: 0,
			updatedAt: 0,
		});
		await created({ title: "Done one", project: "Docs" });
		await created({ title: "Open one", assignee: sam.email, labels: ["Bug"] });
		const [done, open] = workspace.issues_;
		if (!done || !open) throw new Error("No issues");
		Object.assign(done, { status: "done", createdAt: now - 3 * day });
		open.createdAt = now - 3 * day;
		const moved = (id: string, from: string, to: string, at: number): Activity => ({
			id,
			issueId: done.id,
			actorId: me.id,
			change: { type: "status", from, to },
			proposedBy: null,
			source: null,
			createdAt: at,
			updatedAt: at,
		});
		workspace.activities_.push(
			moved("a1", "backlog", "in_progress", now - 2 * day),
			moved("a2", "in_progress", "done", now - day),
		);

		const team = await call("get_insights", { workspace: "acme", team: "eng", weeks: 4 });
		const project = await call("get_insights", { workspace: "acme", project: "docs" });
		const both = await call("get_insights", { workspace: "acme", team: "ENG", project: "Docs" });
		const neither = await call("get_insights", { workspace: "acme" });

		expect(team.isError).toBeFalsy();
		expect(team.structuredContent).toMatchObject({
			team: "ENG",
			timeZone: "UTC",
			created: 2,
			closed: 1,
			open: 1,
			cycleTime: { medianDays: 1, issues: 1 },
			openByStatus: [{ status: "Backlog", category: "backlog", count: 1 }],
			openByTeam: [{ team: "ENG", count: 1 }],
			openByAssignee: [{ assignee: sam.email, count: 1 }],
			openByLabel: [{ label: "Bug", count: 1 }],
		});
		expect((team.structuredContent as { weeks: unknown[] }).weeks).toHaveLength(4);
		expect(project.structuredContent).toMatchObject({
			project: "Docs",
			created: 1,
			closed: 1,
			open: 0,
			openByTeam: [],
		});
		expect(project.structuredContent).not.toHaveProperty("openByStatus");
		expect((project.structuredContent as { weeks: unknown[] }).weeks).toHaveLength(12);
		expect(both.content).toEqual([{ type: "text", text: "Give a team or a project, not both." }]);
		expect(neither.isError).toBe(true);
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

	it("plans issues into a team's cycles: the current one, the next or one by number", async () => {
		const today = dayIn("UTC", Date.now());
		const cycle = (
			id: string,
			number: number,
			startsOn: string,
			completedAt: number | null = null,
		) => ({
			id,
			teamId: team.id,
			number,
			name: null,
			startsOn,
			endsOn: addDays(startsOn, 13),
			completedAt,
			createdAt: 0,
			updatedAt: 0,
		});
		workspace.teams = [{ ...team, cycles: { weeks: 2, timeZone: "UTC" } }];
		workspace.cycles = [
			cycle("c-1", 1, addDays(today, -15), 1),
			cycle("c-2", 2, addDays(today, -1)),
			cycle("c-3", 3, addDays(today, 13)),
		];

		const listed = (await call("get_workspace", { workspace: "acme" })).structuredContent;
		expect(listed).toMatchObject({
			teams: [{ key: "ENG", cycles: { weeks: 2, timeZone: "UTC" } }],
			cycles: [
				{ team: "ENG", number: 2, name: null, startsOn: addDays(today, -1), current: true },
				{ team: "ENG", number: 3, name: null, startsOn: addDays(today, 13), current: false },
			],
		});

		await created({ title: "In this cycle", cycle: "current" });
		expect(workspace.mutations.at(-1)).toMatchObject({ args: { cycleId: "c-2" } });
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-1" })).structuredContent,
		).toMatchObject({ cycle: 2 });

		const update = (cycle: unknown) =>
			call("update_issue", { workspace: "acme", key: "ENG-1", cycle });
		await update("next");
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-1" })).structuredContent,
		).toMatchObject({ cycle: 3 });
		await update(null);
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-1" })).structuredContent,
		).toMatchObject({ cycle: null });
		expect(await update(7)).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "Team ENG has no cycle 7. See get_workspace." }],
		});

		await update(2);
		const found = await call("search_issues", { workspace: "acme", cycle: "current" });
		expect(workspace.queries.at(-1)?.cycleIds).toEqual(["c-2"]);
		expect(found.structuredContent).toMatchObject({ issues: [{ key: "ENG-1", cycle: 2 }] });
		expect(await call("search_issues", { workspace: "acme", cycle: 2 })).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "Name the team of a cycle by its number." }],
		});

		workspace.teams = [team];
		expect(await update("current")).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "Team ENG does not work in cycles." }],
		});
	});

	it("lists workspaces, teams and members", async () => {
		expect((await call("list_workspaces")).structuredContent).toEqual({
			workspaces: [{ slug: "acme", name: "Acme", role: "owner" }],
		});
		expect((await call("get_workspace", { workspace: "acme" })).structuredContent).toEqual({
			teams: [
				{
					key: "ENG",
					name: "Engineering",
					cycles: null,
					archiveAfterMonths: null,
					closeAfterMonths: null,
					statuses: [
						{ key: "backlog", name: "Backlog", category: "backlog" },
						{ key: "todo", name: "Todo", category: "unstarted" },
						{ key: "in_progress", name: "In Progress", category: "started" },
						{ key: "in_review", name: "In Review", category: "started" },
						{ key: "done", name: "Done", category: "completed" },
						{ key: "canceled", name: "Canceled", category: "canceled" },
					],
					templates: [],
				},
			],
			cycles: [],
			labels: [],
			projects: [],
			members: [
				{ id: me.id, name: "Maya", email: "maya@example.com", role: "owner" },
				{ id: sam.id, name: "Sam", email: "sam@example.com", role: "member" },
			],
			you: { id: me.id, name: "Maya", role: "owner" },
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
			url: "https://track.example.com/acme/issue/ENG-2",
		});
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-2" })).structuredContent,
		).toMatchObject({ creator: "maya@example.com", description: "Details" });
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

	it("sets and clears an issue's dates and estimate", async () => {
		await created({
			title: "Launch",
			start_date: "2026-11-02",
			due_date: "2026-11-20",
			estimate: 5,
		});
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-1" })).structuredContent,
		).toMatchObject({ startDate: "2026-11-02", dueDate: "2026-11-20", estimate: 5 });

		await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			due_date: null,
			estimate: 0,
		});

		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-1" })).structuredContent,
		).toMatchObject({
			startDate: "2026-11-02",
			dueDate: null,
			estimate: 0,
		});
		expect(workspace.mutations.at(-1)).toMatchObject({
			name: "issue.update",
			args: { patch: { dueDate: null, estimate: 0 } },
		});
		await created({ title: "Bare" });
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-2" })).structuredContent,
		).toMatchObject({ dueDate: null });
	});

	it("puts an issue under a parent, lists sub-issues, and makes it top-level again", async () => {
		await created({ title: "Launch" });
		const child = await created({ title: "Write the post", parent: "eng-1" });
		expect(child).toMatchObject({ key: "ENG-2" });
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-2" })).structuredContent,
		).toMatchObject({ parent: "ENG-1" });
		expect(workspace.mutations.at(-1)).toMatchObject({
			name: "issue.create",
			args: { parentId: workspace.issues_[0]?.id },
		});

		const parent = await call("get_issue", { workspace: "acme", key: "ENG-1" });
		expect(parent.structuredContent).toMatchObject({
			parent: null,
			subIssues: [{ key: "ENG-2", title: "Write the post" }],
		});
		const found = await call("search_issues", { workspace: "acme", parent: "ENG-1" });
		expect(found.structuredContent).toMatchObject({ issues: [{ key: "ENG-2" }] });

		await call("update_issue", { workspace: "acme", key: "ENG-2", parent: null });
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-2" })).structuredContent,
		).toMatchObject({ parent: null });
		expect(workspace.mutations.at(-1)).toMatchObject({ args: { patch: { parentId: null } } });
	});

	it("says which parent it cannot find, without writing", async () => {
		const result = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Orphan",
			parent: "ENG-99",
		});
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Issue ENG-99 not found." }]);
		expect(workspace.mutations).toEqual([]);
	});

	it("starts an issue from a team's template, and lets what it is given win", async () => {
		workspace.labels = ["Bug", "UI"].map((name) => ({
			id: name.toLowerCase(),
			name,
			color: "#e5484d",
			createdAt: 0,
			updatedAt: 0,
		}));
		const bug: IssueTemplate = {
			id: "t-bug",
			teamId: team.id,
			name: "Bug report",
			title: "Bug: ",
			description: "## Steps",
			priority: 2,
			// A label deleted since is left out.
			labelIds: ["bug", "gone"],
			assigneeId: sam.id,
			repeat: null,
			nextOn: null,
			createdAt: 0,
			updatedAt: 0,
		};
		// Its assignee has left the workspace, and Track files it every Monday.
		const weekly = {
			every: 1,
			unit: "week" as const,
			startsOn: "2026-11-02",
			timeZone: "Europe/Istanbul",
		};
		const chore = {
			...bug,
			id: "t-chore",
			name: "Chore",
			title: "Weekly chores",
			description: null,
			repeat: weekly,
			nextOn: "2026-11-09",
		};
		workspace.templates = [bug, { ...chore, priority: 0, labelIds: [], assigneeId: "user-gone" }];

		expect((await call("get_workspace", { workspace: "acme" })).structuredContent).toMatchObject({
			teams: [
				{
					key: "ENG",
					templates: [
						{
							name: "Bug report",
							title: "Bug: ",
							description: "## Steps",
							priority: "high",
							assignee: sam.id,
							labels: ["Bug"],
							repeat: null,
							nextOn: null,
						},
						{
							name: "Chore",
							title: "Weekly chores",
							description: null,
							priority: "none",
							assignee: null,
							labels: [],
							repeat: weekly,
							nextOn: "2026-11-09",
						},
					],
				},
			],
		});

		await created({ title: "Bug: Login fails", template: " bug REPORT " });
		expect(workspace.mutations.at(-1)).toMatchObject({
			name: "issue.create",
			args: {
				title: "Bug: Login fails",
				description: "## Steps",
				priority: 2,
				assigneeId: sam.id,
				labelIds: ["bug"],
			},
		});

		await created({
			title: "Bug: Safari only",
			template: "Bug report",
			description: "On Safari",
			priority: "low",
			assignee: "none",
			labels: ["UI"],
		});
		expect(workspace.mutations.at(-1)).toMatchObject({
			args: { description: "On Safari", priority: 4, assigneeId: null, labelIds: ["ui"] },
		});

		const count = workspace.mutations.length;
		const missing = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "New idea",
			template: "Feature",
		});
		expect(missing.isError).toBe(true);
		expect(missing.content).toEqual([
			{
				type: "text",
				text: 'Team ENG has no template "Feature". Its templates: Bug report, Chore.',
			},
		]);
		expect(workspace.mutations).toHaveLength(count);
	});

	it("links issues, reads relations from both sides, and unlinks them", async () => {
		await created({ title: "API" });
		await created({ title: "Mockups" });
		const [api, mockups] = workspace.issues_;

		const linked = await call("link_issues", {
			workspace: "acme",
			key: "ENG-1",
			relation: "blocked_by",
			to: "eng-2",
		});
		expect(linked.structuredContent).toEqual({
			key: "ENG-1",
			relations: [
				{
					relation: "blocked_by",
					key: "ENG-2",
					title: "Mockups",
					status: "backlog",
					statusName: "Backlog",
					url: "https://track.example.com/acme/issue/ENG-2",
				},
			],
		});
		// Blocked by is stored as the other issue blocking this one.
		expect(workspace.mutations.at(-1)).toMatchObject({
			name: "relation.create",
			args: { type: "blocks", issueId: mockups?.id, relatedIssueId: api?.id },
		});
		const other = await call("get_issue", { workspace: "acme", key: "ENG-2" });
		expect(other.structuredContent).toMatchObject({
			relations: [{ relation: "blocks", key: "ENG-1" }],
		});

		const self = await call("link_issues", {
			workspace: "acme",
			key: "ENG-1",
			relation: "related",
			to: "ENG-1",
		});
		expect(self.isError).toBe(true);

		const unlinked = await call("unlink_issues", {
			workspace: "acme",
			key: "ENG-2",
			from: "ENG-1",
		});
		expect(unlinked.structuredContent).toEqual({ key: "ENG-2", relations: [] });
		const again = await call("unlink_issues", { workspace: "acme", key: "ENG-2", from: "ENG-1" });
		expect(again.content).toEqual([{ type: "text", text: "ENG-2 and ENG-1 are not related." }]);
	});

	it("refuses days that do not exist and estimates that are not whole points", async () => {
		const day = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Nope",
			due_date: "2026-02-30",
		});
		const size = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Nope",
			estimate: 1.5,
		});
		expect(day.isError).toBe(true);
		expect(size.isError).toBe(true);
		expect(workspace.mutations).toEqual([]);
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

	it("archives an issue it closes in the same call, and searches with or without archived ones", async () => {
		await created({ title: "Shipped" });
		await created({ title: "Still open" });

		const updated = await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			status: "done",
			archived: true,
		});
		expect(updated.structuredContent).toMatchObject({ status: "done" });
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-1" })).structuredContent,
		).toMatchObject({ archived: true });
		// The status first, so the issue is closed by the time it is archived.
		expect(workspace.mutations.slice(-2).map((mutation) => mutation.name)).toEqual([
			"issue.update",
			"issue.archive",
		]);

		const titles = async (archived?: boolean) =>
			(
				(await call("search_issues", { workspace: "acme", archived })).structuredContent as {
					issues: { title: string; archived: boolean }[];
				}
			).issues.map((issue) => `${issue.title}${issue.archived ? " (archived)" : ""}`);
		expect(await titles()).toEqual(expect.arrayContaining(["Shipped (archived)", "Still open"]));
		expect(await titles(false)).toEqual(["Still open"]);
		expect(await titles(true)).toEqual(["Shipped (archived)"]);

		await call("update_issue", {
			workspace: "acme",
			key: "ENG-1",
			archived: false,
		});
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-1" })).structuredContent,
		).toMatchObject({ archived: false });
	});

	it("tells an agent its decision on a request waits for a person", async () => {
		await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Dark mode",
			intake: true,
		});
		workspace.me = { ...me, role: "agent" };
		const declined = await call("triage_request", {
			workspace: "acme",
			key: "ENG-1",
			decision: "decline",
			reply: "Already planned in ENG-9.",
		});
		expect(declined.structuredContent).toMatchObject({
			intake: true,
			proposed: [{ change: "decline", to: "Already planned in ENG-9." }],
		});
		const accepted = await call("triage_request", {
			workspace: "acme",
			key: "ENG-1",
			decision: "accept",
		});
		expect(accepted.structuredContent).toMatchObject({
			proposed: [{ change: "accept", to: null }],
		});
	});

	it("files requests into intake, finds them, and accepts or declines them", async () => {
		const filed = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Export to PDF",
			intake: true,
		});
		expect(filed.structuredContent).toMatchObject({ key: "ENG-1" });
		expect(
			(await call("get_issue", { workspace: "acme", key: "ENG-1" })).structuredContent,
		).toMatchObject({ intake: true });
		expect(workspace.mutations.at(-1)).toMatchObject({ args: { intake: true } });
		await created({ title: "Planned work" });

		const titles = async (intake?: boolean) =>
			(
				(await call("search_issues", { workspace: "acme", intake })).structuredContent as {
					issues: { title: string }[];
				}
			).issues.map((issue) => issue.title);
		expect(await titles(true)).toEqual(["Export to PDF"]);
		expect(await titles(false)).toEqual(["Planned work"]);

		const notRequest = await call("triage_request", {
			workspace: "acme",
			key: "ENG-2",
			decision: "accept",
		});
		expect(notRequest.isError).toBe(true);

		const accepted = await call("triage_request", {
			workspace: "acme",
			key: "ENG-1",
			decision: "accept",
			status: "Todo",
		});
		expect(accepted.structuredContent).toMatchObject({ intake: false, status: "todo" });
		expect(workspace.mutations.at(-1)).toEqual({
			name: "issue.accept",
			args: { id: expect.any(String), status: "todo" },
		});

		await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Dark mode",
			intake: true,
		});
		const declined = await call("triage_request", {
			workspace: "acme",
			key: "ENG-3",
			decision: "decline",
			reply: "We track this in ENG-9.",
		});
		expect(declined.structuredContent).toMatchObject({ intake: false });
		expect(workspace.mutations.at(-1)).toMatchObject({
			name: "issue.decline",
			args: { reply: { body: "We track this in ENG-9." } },
		});
	});

	it("refuses an update that changes nothing", async () => {
		await created({ title: "Still" });
		const result = await call("update_issue", { workspace: "acme", key: "ENG-1" });
		expect(result.isError).toBe(true);
		expect(workspace.mutations).toHaveLength(1);
	});

	it("takes a team's own statuses by key or by name, and names them back", async () => {
		const qa: WorkflowStatus = {
			id: `${team.id}/qa`,
			teamId: team.id,
			key: "qa",
			name: "Ready for QA",
			category: "started",
			color: null,
			sortOrder: "a3V",
			createdAt: 0,
			updatedAt: 0,
			removedAt: null,
		};
		workspace.statuses = [...workspace.statuses, qa];

		const made = await call("create_issue", {
			workspace: "acme",
			team: "ENG",
			title: "Login",
			status: "ready for qa",
		});
		expect(made.structuredContent).toMatchObject({ status: "qa", statusName: "Ready for QA" });
		expect(workspace.mutations.at(-1)).toMatchObject({
			name: "issue.create",
			args: { status: "qa" },
		});

		// Without a status, the server gives the team's first, so the tool sends none.
		await call("create_issue", { workspace: "acme", team: "ENG", title: "Later" });
		expect(workspace.mutations.at(-1)?.args).not.toHaveProperty("status");

		await call("update_issue", { workspace: "acme", key: "ENG-2", status: "Shipping" }).then(
			(result) =>
				expect(result).toMatchObject({
					isError: true,
					content: [
						{
							type: "text",
							text: 'Team ENG has no status "Shipping". Its statuses: Backlog, Todo, In Progress, In Review, Ready for QA, Done, Canceled.',
						},
					],
				}),
		);

		const found = await call("search_issues", { workspace: "acme", status: ["Ready for QA"] });
		expect(found.structuredContent).toMatchObject({ issues: [{ key: "ENG-1" }] });
		expect(workspace.queries.at(-1)?.statuses).toEqual(["qa"]);
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
			pullRequests: [],
		});
		expect(missing.content).toEqual([{ type: "text", text: "Issue ENG-9 not found." }]);
		expect(malformed.isError).toBe(true);
	});

	it("lists the pull requests that mention an issue", async () => {
		await created({ title: "Fix login" });
		const issueId = workspace.issues_[0]?.id ?? "";
		workspace.pullRequests_.push({
			id: "github:1",
			repository: "acme/app",
			number: 7,
			title: "Fix login",
			url: "https://github.com/acme/app/pull/7",
			state: "open",
			branch: "eng-1-fix-login",
			author: "octocat",
			issueIds: [issueId],
			closingIssueIds: [issueId],
			createdAt: 1,
			updatedAt: 1,
		});

		const read = await call("get_issue", { workspace: "acme", key: "ENG-1" });

		expect(read.structuredContent).toMatchObject({
			pullRequests: [
				{
					repository: "acme/app",
					number: 7,
					title: "Fix login",
					state: "open",
					fixes: true,
					author: "octocat",
					url: "https://github.com/acme/app/pull/7",
				},
			],
		});
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

		expect(added.structuredContent).toMatchObject({
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
		expect((read.structuredContent as { comments: { id: string }[] }).comments.at(-1)?.id).toBe(
			(added.structuredContent as { id: string }).id,
		);
		expect(missing.isError).toBe(true);
		expect(workspace.mutations.filter((m) => m.name === "comment.create")).toHaveLength(1);
	});

	it("names what filed a request and wrote a reply on its own, where no member did", async () => {
		await created({ title: "Emailed" });
		const issue = workspace.issues_[0];
		if (!issue) throw new Error("No issue");
		issue.creatorId = INTAKE_EMAIL_ACTOR_ID;
		workspace.comments_.push({
			id: "comment-reply",
			issueId: issue.id,
			authorId: INTAKE_EMAIL_ACTOR_ID,
			body: "Thanks!",
			createdAt: Date.UTC(2026, 9, 27),
			updatedAt: Date.UTC(2026, 9, 27),
		});

		const read = await call("get_issue", { workspace: "acme", key: "ENG-1" });
		expect(read.structuredContent).toMatchObject({
			creator: "Email",
			comments: [{ author: "Email", body: "Thanks!" }],
		});
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

	it("creates a project with a lead and a target date, and defaults the rest", async () => {
		const full = await call("create_project", {
			workspace: "acme",
			name: "  Public launch  ",
			description: "Ship it",
			status: "started",
			lead: "SAM@example.com",
			target_date: "2026-12-01",
		});
		const bare = await call("create_project", { workspace: "acme", name: "Docs", lead: "me" });

		expect(full.structuredContent).toMatchObject({
			name: "Public launch",
			description: "Ship it",
			status: "started",
			lead: "sam@example.com",
			targetDate: "2026-12-01",
		});
		expect(bare.structuredContent).toMatchObject({
			name: "Docs",
			description: null,
			status: "planned",
			lead: "maya@example.com",
			targetDate: null,
		});
		expect(workspace.mutations.map((m) => m.name)).toEqual(["project.create", "project.create"]);
		expect((await call("get_workspace", { workspace: "acme" })).structuredContent).toMatchObject({
			projects: [
				{ name: "Public launch", status: "started" },
				{ name: "Docs", status: "planned" },
			],
		});
	});

	it("updates a project found by name, clearing the target date and changing the lead", async () => {
		await call("create_project", {
			workspace: "acme",
			name: "Public launch",
			lead: "me",
			target_date: "2026-12-01",
		});

		const result = await call("update_project", {
			workspace: "acme",
			project: "PUBLIC LAUNCH",
			status: "paused",
			lead: "sam@example.com",
			target_date: null,
		});
		const cleared = await call("update_project", {
			workspace: "acme",
			project: workspace.projects[0]?.id,
			lead: null,
			description: "Later",
		});

		expect(result.structuredContent).toMatchObject({
			name: "Public launch",
			status: "paused",
			lead: "sam@example.com",
			targetDate: null,
		});
		expect(cleared.structuredContent).toMatchObject({
			status: "paused",
			lead: null,
			description: "Later",
		});
		expect(workspace.mutations.at(-2)).toEqual({
			name: "project.update",
			args: {
				id: workspace.projects[0]?.id,
				patch: { status: "paused", leadId: sam.id, targetDate: null },
			},
		});
	});

	it("refuses an unknown project, a bad date and an empty update without writing", async () => {
		await call("create_project", { workspace: "acme", name: "Docs" });

		const unknown = await call("update_project", {
			workspace: "acme",
			project: "Launch",
			status: "started",
		});
		const empty = await call("update_project", { workspace: "acme", project: "Docs" });
		const date = await call("update_project", {
			workspace: "acme",
			project: "Docs",
			target_date: "2026-02-30",
		});

		expect(unknown.content).toEqual([
			{ type: "text", text: 'No project "Launch". Projects: Docs. See get_workspace.' },
		]);
		expect(empty.isError).toBe(true);
		expect(date.isError).toBe(true);
		expect(workspace.mutations.map((m) => m.name)).toEqual(["project.create"]);
	});

	it("passes on the server's refusal when an agent member creates or changes a project", async () => {
		workspace.me = { ...me, role: "agent" };
		const created = await call("create_project", { workspace: "acme", name: "Docs" });
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
		const updated = await call("update_project", {
			workspace: "acme",
			project: "Docs",
			status: "started",
		});

		expect(created.isError).toBe(true);
		expect(created.content).toEqual([{ type: "text", text: "Agents cannot create projects" }]);
		expect(updated.content).toEqual([{ type: "text", text: "Agents cannot change projects" }]);
		expect(workspace.projects.map((project) => project.status)).toEqual(["planned"]);
	});

	it("posts project updates, lists them latest first, and gives the project its health", async () => {
		workspace.projects.push({
			id: "p-docs",
			name: "Docs",
			description: null,
			status: "started",
			leadId: null,
			targetDate: null,
			createdAt: 0,
			updatedAt: 0,
		});
		// Agents post updates too: it changes nothing about the project but its record.
		workspace.me = { ...me, role: "agent" };
		const first = await call("post_project_update", {
			workspace: "acme",
			project: "docs",
			health: "at_risk",
			body: "The API reference is behind.",
		});
		const second = await call("post_project_update", {
			workspace: "acme",
			project: "p-docs",
			health: "on_track",
			body: "Caught up.",
		});
		const listed = await call("list_project_updates", { workspace: "acme", project: "Docs" });
		const unknown = await call("post_project_update", {
			workspace: "acme",
			project: "Nope",
			health: "on_track",
			body: "Hello",
		});
		const health = await call("post_project_update", {
			workspace: "acme",
			project: "Docs",
			health: "great",
			body: "Hello",
		});
		const { structuredContent } = await call("get_workspace", { workspace: "acme" });

		expect(first.structuredContent).toMatchObject({
			health: "at_risk",
			author: me.email,
			body: "The API reference is behind.",
			edited: false,
		});
		expect(second.isError).toBeFalsy();
		expect(listed.structuredContent).toMatchObject({
			updates: [
				{ health: "on_track", body: "Caught up." },
				{ health: "at_risk", body: "The API reference is behind." },
			],
		});
		expect(unknown.isError).toBe(true);
		expect(health.isError).toBe(true);
		expect(workspace.mutations.filter((m) => m.name === "projectUpdate.create")).toHaveLength(2);
		expect(structuredContent).toMatchObject({
			projects: [{ id: "p-docs", name: "Docs", status: "started", health: "on_track" }],
		});
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

describe("panel tools", () => {
	const scope = { workspace: "acme", panel: "panel" };
	const deadline = new Date(Date.now() + 3600000).toISOString();
	const hidden = "SECRET-ALPHA-7731";
	async function setup() {
		const issue = await created({ title: "Panel question" });
		const row = workspace.issues_[0];
		if (!row) throw new Error("Missing issue");
		const panel: PanelView = {
			id: "panel",
			issueId: row.id,
			issueRef: { teamId: row.teamId, number: row.number },
			openedBy: me.id,
			deadlineAt: Date.parse(deadline),
			openedAt: 0,
			round: 1,
			state: "open",
			revealedAt: null,
			revealReason: null,
			seats: [{ memberId: sam.id, submitted: true }],
			own: null,
			positions: null,
			absent: null,
		};
		return { panel, key: issue.key };
	}
	it("advertises panel inputs and annotations", async () => {
		const { tools } = await client.listTools();
		for (const [name, required, annotations] of [
			[
				"open_panel",
				["workspace", "key", "seats", "deadline"],
				{ readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			],
			[
				"submit_position",
				["workspace", "panel", "body"],
				{
					readOnlyHint: false,
					destructiveHint: false,
					openWorldHint: false,
					idempotentHint: false,
				},
			],
			["get_panel", ["workspace", "panel"], { readOnlyHint: true, openWorldHint: false }],
		] as const) {
			const tool = tools.find((t) => t.name === name);
			expect(tool?.annotations).toMatchObject(annotations);
			expect(tool?.inputSchema.required?.toSorted()).toEqual([...required].sort());
		}
	});
	it("resolves seat emails and validates offset deadlines before opening", async () => {
		const { panel, key } = await setup();
		workspace.openPanel.mockResolvedValue({ ok: true, value: panel });
		const input = { workspace: "acme", key, deadline, seats: [sam.email] };
		const result = await call("open_panel", input);
		expect(result.structuredContent).toMatchObject({
			issueKey: key,
			openedBy: me.email,
			deadline,
			seats: [{ member: sam.email, submitted: true }],
		});
		expect(result.structuredContent).not.toHaveProperty("issueId");
		expect(workspace.openPanel).toHaveBeenCalledWith({
			issueId: panel.issueId,
			seats: [sam.id],
			deadlineAt: Date.parse(deadline),
		});
		expect(
			(await call("open_panel", { ...input, seats: ["unknown@example.com"] })).content,
		).toEqual([expect.objectContaining({ text: expect.stringContaining("No member") })]);
		expect((await call("open_panel", { ...input, deadline: deadline.slice(0, -1) })).isError).toBe(
			true,
		);
		const directory = await workspace.directory();
		vi.spyOn(workspace, "directory").mockResolvedValue({
			...directory,
			members: directory.members.map((member) =>
				member.id === sam.id ? { ...member, removedAt: 1 } : member,
			),
		});
		expect((await call("open_panel", input)).content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("No member") }),
		]);
		expect(workspace.openPanel).toHaveBeenCalledTimes(1);
	});
	it("passes through positions and each refusal message", async () => {
		const { panel } = await setup();
		workspace.submitPosition.mockResolvedValue({ ok: true, value: { ...panel, own: hidden } });
		expect(
			(await call("submit_position", { ...scope, body: hidden })).structuredContent,
		).toMatchObject({ own: hidden });
		expect(workspace.submitPosition).toHaveBeenCalledWith({ panelId: scope.panel, body: hidden });
		const positions = [{ alias: "Position A", body: hidden }];
		workspace.getPanel.mockResolvedValue({
			ok: true,
			value: {
				...panel,
				state: "revealed",
				revealedAt: 1,
				revealReason: "deadline",
				positions,
				absent: [me.id],
			},
		});
		const revealed = await call("get_panel", scope);
		expect(revealed.structuredContent).toMatchObject({
			positions,
			absent: [me.email],
			own: null,
			state: "revealed",
		});
		expect(workspace.getPanel).toHaveBeenCalledWith({ panelId: scope.panel });
		for (const reason of ["invalid", "forbidden", "not_found", "conflict", "expired"] as const) {
			for (const name of ["submit_position", "get_panel"] as const) {
				const rpc = name === "submit_position" ? workspace.submitPosition : workspace.getPanel;
				rpc.mockResolvedValueOnce({ ok: false, reason, message: `Panel refusal ${reason}` });
				const result = await call(name, name === "get_panel" ? scope : { ...scope, body: hidden });
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result.content)).toContain(`Panel refusal ${reason}`);
			}
		}
	});
	it("keeps hidden positions out of get_issue, search_issues and non-seat panel reads", async () => {
		const { key, panel } = await setup();
		workspace.getPanel.mockResolvedValue({ ok: true, value: { ...panel, own: hidden } });
		for (const result of [
			await call("get_issue", { workspace: "acme", key }),
			await call("search_issues", { workspace: "acme", text: hidden }),
		]) {
			expect(result.isError).toBeFalsy();
			expect(JSON.stringify(result)).not.toContain(hidden);
		}
		for (const rpc of [workspace.openPanel, workspace.submitPosition, workspace.getPanel])
			expect(rpc).not.toHaveBeenCalled();
		workspace.getPanel.mockResolvedValueOnce({
			ok: false,
			reason: "not_found",
			message: "Panel not found",
		});
		const denied = await call("get_panel", scope);
		expect(denied.isError).toBe(true);
		expect(JSON.stringify(denied.content)).toContain("Panel not found");
		workspace.getPanel.mockResolvedValueOnce({ ok: true, value: panel });
		const admin = await call("get_panel", scope);
		expect(admin.structuredContent).toMatchObject({
			own: null,
			positions: null,
			seats: [{ member: sam.email, submitted: true }],
		});
		expect(JSON.stringify(admin)).not.toContain(hidden);
	});
});
