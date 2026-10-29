import {
	type Comment,
	ISSUE_STATUSES,
	type Issue,
	type IssuePriority,
	MAX_LABELS_PER_ISSUE,
	MEMBER_ROLES,
	type Member,
	type MutationInput,
	mutationSchema,
	type Proposal,
} from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import type {
	Directory,
	IssueQuery,
	MemberProfile,
	MutateResult,
} from "@gateweave/track-sync-server";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import { issueKey, parseIssueKey } from "#/lib/issues";
import { defaultLabelColor, findLabelByName } from "#/lib/labels";
import { suggestKey } from "#/lib/teams";

// Track's MCP tools. They only reach Track through TrackAccess, which offers what the signed-in
// user can see and do, and nothing more. Free of `cloudflare:workers` imports so the tools can be
// tested in Node.

/** What the tools may do for one signed-in user. */
export interface TrackAccess {
	/** The app's origin, for links back to issues. */
	origin: string;
	workspaces(): Promise<{ slug: string; name: string; role: Member["role"] }[]>;
	/** A workspace the user belongs to; null for any other slug. */
	workspace(slug: string): Promise<WorkspaceAccess | null>;
}

export interface WorkspaceAccess {
	slug: string;
	/** The signed-in user, as a member of this workspace. */
	me: MemberProfile;
	directory(): Promise<Directory>;
	issues(query: IssueQuery): Promise<Issue[]>;
	issue(id: string): Promise<Issue | null>;
	issueByKey(teamKey: string, number: number): Promise<Issue | null>;
	/** A live issue's comments, oldest first. */
	comments(issueId: string): Promise<Comment[]>;
	/** A live issue's open proposals, oldest first. */
	proposals(issueId: string): Promise<Proposal[]>;
	lastSortOrder(): Promise<string | null>;
	/** Applies a mutation as the user, through the same validation as the app's. */
	mutate(mutation: MutationInput): Promise<MutateResult>;
}

const PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
type PriorityName = (typeof PRIORITIES)[number];
const priorityName = (priority: IssuePriority): PriorityName => PRIORITIES[priority];
const priorityValue = (name: PriorityName) => PRIORITIES.indexOf(name) as IssuePriority;

const workspaceInput = z
	.string()
	.min(1)
	.describe("The workspace's slug, from list_workspaces. It is the first segment of app URLs.");
const keyInput = z.string().min(1).describe("The issue's key, such as ENG-42.");
const statusInput = z.enum(ISSUE_STATUSES);
const priorityInput = z.enum(PRIORITIES);
const labelsInput = z
	.array(z.string().min(1))
	.max(MAX_LABELS_PER_ISSUE)
	.describe("Label names, from get_workspace. Make new ones with create_label.");
const projectInput = z
	.string()
	.min(1)
	.describe("A project's name (ignoring case) or id, from get_workspace.");
const assigneeInput = z
	.string()
	.min(1)
	.describe('"me", "none", or a member\'s email or id, from get_workspace.');

// Outputs are loose objects. Clients keep a tool's output schema from when they connected and
// validate results against it, so with a strict schema every field added later would fail their
// calls until they reconnect.
const issueSummary = z.looseObject({
	key: z.string(),
	title: z.string(),
	status: statusInput,
	priority: priorityInput,
	assignee: z.string().nullable().describe("The assignee's email."),
	labels: z.array(z.string()).describe("Label names."),
	project: z.string().nullable().describe("The project's name."),
	url: z.string(),
	updatedAt: z.string(),
});
const issueDetail = issueSummary.extend({
	description: z.string().nullable().describe("Markdown."),
	creator: z.string().nullable().describe("The creator's email."),
	createdAt: z.string(),
});
const commentOutput = z.looseObject({
	author: z.string().nullable().describe("The author's email."),
	body: z.string().describe("Markdown."),
	createdAt: z.string(),
	edited: z.boolean(),
});
// A string rather than an enum, so kinds of change added later do not fail cached schemas.
const proposalOutput = z.looseObject({
	change: z
		.string()
		.describe(
			'What it changes: "title", "description", "status", "priority", "assignee", "project", "add_label" or "remove_label".',
		),
	to: z
		.string()
		.nullable()
		.describe(
			"The proposed value: the text, a status, a priority, an assignee's email, a project's name or a label name. Null clears the field.",
		),
});
const openProposalOutput = proposalOutput.extend({
	by: z.string().nullable().describe("The email of the agent that proposed it."),
	createdAt: z.string(),
});
const proposedOutput = z
	.array(proposalOutput)
	.optional()
	.describe(
		"Changes you proposed instead of making, because an admin set you to propose that kind of change. They wait for a person to accept them, and are not applied yet.",
	);
type IssueSummary = z.infer<typeof issueSummary>;
type IssueDetail = z.infer<typeof issueDetail>;
type CommentOutput = z.infer<typeof commentOutput>;
type ProposalOutput = z.infer<typeof proposalOutput>;

/** What agents are told about proposals, in the tool descriptions that make changes. */
const PROPOSALS_NOTE =
	"If an admin set you to propose some kinds of change, those are not made: they come back under proposed, for a person to accept or dismiss.";

/** A failure the agent can act on. Reported as a tool error, not thrown to the client. */
class ToolError extends Error {}

/** Builds the MCP server for one request. */
export function createTrackServer(access: TrackAccess): McpServer {
	const server = new McpServer({ name: "gateweave-track", version: "1.0.0" });

	server.registerTool(
		"list_workspaces",
		{
			title: "List workspaces",
			description: "Lists the Track workspaces you belong to. Start here to find a slug.",
			outputSchema: z.looseObject({
				workspaces: z.array(
					z.looseObject({ slug: z.string(), name: z.string(), role: z.enum(MEMBER_ROLES) }),
				),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => run(async () => ({ workspaces: await access.workspaces() })),
	);

	server.registerTool(
		"get_workspace",
		{
			title: "Get workspace",
			description:
				"Lists a workspace's teams (whose keys prefix issue keys), its labels, its projects, and its members (who can be assignees).",
			inputSchema: z.object({ workspace: workspaceInput }),
			outputSchema: z.looseObject({
				teams: z.array(z.looseObject({ key: z.string(), name: z.string() })),
				labels: z.array(z.looseObject({ name: z.string(), color: z.string() })),
				projects: z.array(z.looseObject({ id: z.string(), name: z.string(), status: z.string() })),
				members: z.array(
					z.looseObject({
						id: z.string(),
						name: z.string(),
						email: z.string(),
						role: z.enum(MEMBER_ROLES),
					}),
				),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ workspace }) =>
			run(async () => {
				const { teams, labels, projects, members } = await (
					await open(access, workspace)
				).directory();
				return {
					teams: teams.map(({ key, name }) => ({ key, name })),
					labels: labels.map(({ name, color }) => ({ name, color })),
					projects: projects.map(({ id, name, status }) => ({ id, name, status })),
					members: members
						.filter((member) => member.removedAt === null)
						.map(({ id, name, email, role }) => ({ id, name, email, role })),
				};
			}),
	);

	server.registerTool(
		"search_issues",
		{
			title: "Search issues",
			description:
				"Finds issues in a workspace. Every filter is optional. With text, the best matches come first; otherwise the most recently updated.",
			inputSchema: z.object({
				workspace: workspaceInput,
				team: z.string().optional().describe("A team key, such as ENG."),
				status: z.array(statusInput).optional().describe("Any of these statuses."),
				assignee: assigneeInput.optional(),
				label: z.string().min(1).optional().describe("A label name."),
				project: projectInput.optional().describe("Only issues in this project: its name or id."),
				text: z
					.string()
					.max(200)
					.optional()
					.describe(
						'Words to find in the issue\'s key, title, description or comments. Each word matches the start of a word, ignoring case and accents: "auth" finds "authentication".',
					),
				limit: z.number().int().min(1).max(200).default(50),
			}),
			outputSchema: z.looseObject({ issues: z.array(issueSummary) }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) =>
			run(async () => {
				const workspace = await open(access, input.workspace);
				const directory = await workspace.directory();
				const issues = await workspace.issues({
					teamId: input.team === undefined ? undefined : teamId(directory, input.team),
					statuses: input.status,
					assigneeId:
						input.assignee === undefined
							? undefined
							: resolveAssignee(directory, workspace.me, input.assignee),
					labelId: input.label === undefined ? undefined : labelId(directory, input.label),
					projectId: input.project === undefined ? undefined : projectId(directory, input.project),
					text: input.text,
					limit: input.limit,
				});
				return { issues: issues.map((issue) => summarize(access, workspace, directory, issue)) };
			}),
	);

	server.registerTool(
		"get_issue",
		{
			title: "Get issue",
			description:
				"Reads one issue, including its description, its comments, oldest first, and the changes agents proposed that wait for a person.",
			inputSchema: z.object({ workspace: workspaceInput, key: keyInput }),
			outputSchema: issueDetail.extend({
				comments: z.array(commentOutput),
				proposals: z.array(openProposalOutput),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ workspace: slug, key }) =>
			run(async () => {
				const workspace = await open(access, slug);
				const directory = await workspace.directory();
				const issue = await findIssue(workspace, key);
				const [comments, proposals] = await Promise.all([
					workspace.comments(issue.id),
					workspace.proposals(issue.id),
				]);
				return {
					...detail(access, workspace, directory, issue),
					comments: comments.map((comment) => commentView(directory, comment)),
					proposals: proposals.map((proposal) => ({
						...proposalView(directory, proposal),
						by: emailOf(directory, proposal.agentId),
						createdAt: new Date(proposal.createdAt).toISOString(),
					})),
				};
			}),
	);

	server.registerTool(
		"create_issue",
		{
			title: "Create issue",
			description: `Creates an issue in a team, and in a project if you name one. It goes to the end of the manual order. ${PROPOSALS_NOTE}`,
			inputSchema: z.object({
				workspace: workspaceInput,
				team: z.string().describe("The team's key, such as ENG."),
				title: z.string().trim().min(1).max(512),
				description: z.string().max(100_000).optional().describe("Markdown."),
				status: statusInput.default("backlog"),
				priority: priorityInput.default("none"),
				assignee: assigneeInput.optional(),
				project: projectInput.optional(),
				labels: labelsInput.optional(),
			}),
			outputSchema: issueDetail.extend({ proposed: proposedOutput }),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		(input) =>
			run(async () => {
				const workspace = await open(access, input.workspace);
				const directory = await workspace.directory();
				const id = uuidv7();
				const proposed = await apply(workspace, {
					name: "issue.create",
					args: {
						id,
						teamId: teamId(directory, input.team),
						title: input.title,
						description: input.description?.trim() ? input.description : null,
						status: input.status,
						priority: priorityValue(input.priority),
						assigneeId:
							input.assignee === undefined
								? null
								: resolveAssignee(directory, workspace.me, input.assignee),
						projectId: input.project === undefined ? null : projectId(directory, input.project),
						labelIds: (input.labels ?? []).map((name) => labelId(directory, name)),
						sortOrder: generateKeyBetween(await workspace.lastSortOrder(), null),
					},
				});
				return withProposed(
					detail(access, workspace, directory, await reread(workspace, id)),
					directory,
					proposed,
				);
			}),
	);

	server.registerTool(
		"update_issue",
		{
			title: "Update issue",
			description: `Changes an issue's title, description, status, priority, assignee, project or labels. Fields you leave out stay as they are. ${PROPOSALS_NOTE}`,
			inputSchema: z.object({
				workspace: workspaceInput,
				key: keyInput,
				title: z.string().trim().min(1).max(512).optional(),
				description: z
					.string()
					.max(100_000)
					.nullable()
					.optional()
					.describe("Markdown. Null clears it."),
				status: statusInput.optional(),
				priority: priorityInput.optional(),
				assignee: assigneeInput.optional(),
				project: projectInput
					.nullable()
					.optional()
					.describe("Moves the issue to this project. Null takes it out of its project."),
				add_labels: labelsInput.optional(),
				remove_labels: labelsInput.optional(),
			}),
			outputSchema: issueDetail.extend({ proposed: proposedOutput }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		(input) =>
			run(async () => {
				const workspace = await open(access, input.workspace);
				const directory = await workspace.directory();
				const issue = await findIssue(workspace, input.key);
				const patch = {
					...(input.title !== undefined && { title: input.title }),
					...(input.description !== undefined && {
						description: input.description?.trim() ? input.description : null,
					}),
					...(input.status !== undefined && { status: input.status }),
					...(input.priority !== undefined && { priority: priorityValue(input.priority) }),
					...(input.assignee !== undefined && {
						assigneeId: resolveAssignee(directory, workspace.me, input.assignee),
					}),
					...(input.project !== undefined && {
						projectId: input.project === null ? null : projectId(directory, input.project),
					}),
				};
				const added = (input.add_labels ?? []).map((name) => labelId(directory, name));
				const removed = (input.remove_labels ?? []).map((name) => labelId(directory, name));
				if (Object.keys(patch).length === 0 && added.length === 0 && removed.length === 0) {
					throw new ToolError("Nothing to change.");
				}
				const proposed: Proposal[] = [];
				if (Object.keys(patch).length > 0) {
					// The issue was read just now, so only an edit landing in between can conflict.
					proposed.push(
						...(await apply(workspace, {
							name: "issue.update",
							args: { id: issue.id, baseVersion: issue.version, patch },
						})),
					);
				}
				// Label changes are set operations, so they never conflict.
				for (const id of added) {
					proposed.push(
						...(await apply(workspace, {
							name: "issue.addLabel",
							args: { id: issue.id, labelId: id },
						})),
					);
				}
				for (const id of removed) {
					proposed.push(
						...(await apply(workspace, {
							name: "issue.removeLabel",
							args: { id: issue.id, labelId: id },
						})),
					);
				}
				return withProposed(
					detail(access, workspace, directory, await reread(workspace, issue.id)),
					directory,
					proposed,
				);
			}),
	);

	server.registerTool(
		"add_comment",
		{
			title: "Add comment",
			description: "Comments on an issue as you. Everyone in the workspace sees it at once.",
			inputSchema: z.object({
				workspace: workspaceInput,
				key: keyInput,
				body: z.string().trim().min(1).max(100_000).describe("Markdown."),
			}),
			outputSchema: commentOutput,
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		(input) =>
			run(async () => {
				const workspace = await open(access, input.workspace);
				const issue = await findIssue(workspace, input.key);
				const id = uuidv7();
				await apply(workspace, {
					name: "comment.create",
					args: { id, issueId: issue.id, body: input.body },
				});
				const comment = (await workspace.comments(issue.id)).find((comment) => comment.id === id);
				// Only a concurrent delete of the issue gets here.
				if (!comment) throw new ToolError("The issue was deleted.");
				return commentView(await workspace.directory(), comment);
			}),
	);

	server.registerTool(
		"create_label",
		{
			title: "Create label",
			description:
				"Creates a label that any issue in the workspace can have. Names are unique, ignoring case.",
			inputSchema: z.object({
				workspace: workspaceInput,
				name: z.string().trim().min(1).max(64),
				color: z
					.string()
					.regex(/^#[0-9a-f]{6}$/)
					.optional()
					.describe("A lowercase hex color, like #e5484d. One is picked if you leave it out."),
			}),
			outputSchema: z.looseObject({ name: z.string(), color: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		(input) =>
			run(async () => {
				const workspace = await open(access, input.workspace);
				const existing = findLabelByName((await workspace.directory()).labels, input.name);
				if (existing) throw new ToolError(`A label named "${existing.name}" already exists.`);
				const color = input.color ?? defaultLabelColor(input.name);
				await apply(workspace, {
					name: "label.create",
					args: { id: uuidv7(), name: input.name, color },
				});
				return { name: input.name, color };
			}),
	);

	server.registerTool(
		"create_team",
		{
			title: "Create team",
			description:
				"Creates a team, which groups issues and gives them their key prefix. Only workspace admins can create teams. Use it to set up a new workspace before creating issues.",
			inputSchema: z.object({
				workspace: workspaceInput,
				name: z.string().trim().min(1).max(64),
				key: z
					.string()
					.trim()
					.min(1)
					.max(7)
					.optional()
					.describe(
						"Uppercase letters or digits, starting with a letter, like ENG. Derived from the name if you leave it out.",
					),
			}),
			outputSchema: z.looseObject({ key: z.string(), name: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		(input) =>
			run(async () => {
				const workspace = await open(access, input.workspace);
				const key = (input.key ?? suggestKey(input.name)).toUpperCase();
				const mutation = {
					name: "team.create" as const,
					args: { id: uuidv7(), key, name: input.name },
				};
				// The same checks the app makes before sending, so the agent gets the reason.
				const parsed = mutationSchema.safeParse(mutation);
				if (!parsed.success) {
					throw new ToolError(parsed.error.issues[0]?.message ?? "Check the name and key.");
				}
				const result = await workspace.mutate(mutation);
				// A conflict here can only be a taken key, so it gets its own message rather than apply()'s.
				if (!result.ok) {
					throw new ToolError(
						result.reason === "conflict" ? `Team key ${key} is already in use.` : result.message,
					);
				}
				return { key, name: input.name };
			}),
	);

	return server;
}

/** Runs a tool body, returning its result as structured content or its failure as a tool error. */
async function run(body: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
	try {
		const result = await body();
		return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		return { content: [{ type: "text", text: error.message }], isError: true };
	}
}

async function open(access: TrackAccess, slug: string): Promise<WorkspaceAccess> {
	const workspace = await access.workspace(slug);
	// The same answer for a workspace that does not exist, so slugs cannot be probed.
	if (!workspace) throw new ToolError(`Workspace "${slug}" not found. See list_workspaces.`);
	return workspace;
}

/** Applies a mutation, returning what it proposed instead of making. */
async function apply(workspace: WorkspaceAccess, mutation: MutationInput): Promise<Proposal[]> {
	const result = await workspace.mutate(mutation);
	if (result.ok) return result.proposed;
	throw new ToolError(
		result.reason === "conflict"
			? "Someone changed the same fields a moment ago. Read the issue again and retry."
			: result.message,
	);
}

async function findIssue(workspace: WorkspaceAccess, key: string): Promise<Issue> {
	const parsed = parseIssueKey(key);
	const issue = parsed && (await workspace.issueByKey(parsed.teamKey, parsed.number));
	if (!issue) throw new ToolError(`Issue ${key} not found.`);
	return issue;
}

async function reread(workspace: WorkspaceAccess, id: string): Promise<Issue> {
	const issue = await workspace.issue(id);
	// Only a concurrent delete gets here.
	if (!issue) throw new ToolError("The issue was deleted.");
	return issue;
}

function teamId(directory: Directory, key: string): string {
	const team = directory.teams.find((team) => team.key === key.trim().toUpperCase());
	if (!team) {
		const keys = directory.teams.map((team) => team.key).join(", ") || "none";
		throw new ToolError(`No team with key "${key}". Teams: ${keys}.`);
	}
	return team.id;
}

function projectId(directory: Directory, nameOrId: string): string {
	const value = nameOrId.trim();
	const folded = value.toLowerCase();
	const project =
		directory.projects.find((project) => project.id === value) ??
		directory.projects.find((project) => project.name.toLowerCase() === folded);
	if (!project) {
		const names = directory.projects.map((project) => project.name).join(", ") || "none";
		throw new ToolError(`No project "${nameOrId}". Projects: ${names}. See get_workspace.`);
	}
	return project.id;
}

function labelId(directory: Directory, name: string): string {
	const label = findLabelByName(directory.labels, name);
	if (!label) {
		const names = directory.labels.map((label) => label.name).join(", ") || "none";
		throw new ToolError(`No label "${name}". Labels: ${names}. Make one with create_label.`);
	}
	return label.id;
}

/** Resolves "me", "none", an email or an id to a member id, or null for unassigned. */
export function resolveAssignee(
	directory: Directory,
	me: MemberProfile,
	assignee: string,
): string | null {
	const value = assignee.trim();
	if (value.toLowerCase() === "me") return me.id;
	if (value.toLowerCase() === "none") return null;
	const member = directory.members.find(
		(member) =>
			member.removedAt === null &&
			(member.id === value || member.email.toLowerCase() === value.toLowerCase()),
	);
	if (!member) throw new ToolError(`No member "${assignee}". See get_workspace.`);
	return member.id;
}

function summarize(
	access: TrackAccess,
	workspace: WorkspaceAccess,
	directory: Directory,
	issue: Issue,
): IssueSummary {
	const key = issueKey(
		directory.teams.find((team) => team.id === issue.teamId),
		issue,
	);
	return {
		key,
		title: issue.title,
		status: issue.status,
		priority: priorityName(issue.priority),
		assignee: emailOf(directory, issue.assigneeId),
		labels: issue.labelIds
			.map((id) => directory.labels.find((label) => label.id === id)?.name)
			.filter((name) => name !== undefined),
		project: directory.projects.find((project) => project.id === issue.projectId)?.name ?? null,
		url: `${access.origin}/${encodeURIComponent(workspace.slug)}/issue/${key}`,
		updatedAt: new Date(issue.updatedAt).toISOString(),
	};
}

function detail(
	access: TrackAccess,
	workspace: WorkspaceAccess,
	directory: Directory,
	issue: Issue,
): IssueDetail {
	return {
		...summarize(access, workspace, directory, issue),
		description: issue.description,
		creator: emailOf(directory, issue.creatorId),
		createdAt: new Date(issue.createdAt).toISOString(),
	};
}

/** An issue's detail, with what the call proposed when it proposed anything. */
function withProposed(issue: IssueDetail, directory: Directory, proposed: Proposal[]) {
	if (proposed.length === 0) return issue;
	return { ...issue, proposed: proposed.map((proposal) => proposalView(directory, proposal)) };
}

function proposalView(directory: Directory, { change }: Proposal): ProposalOutput {
	switch (change.type) {
		case "title":
		case "description":
		case "status":
			return { change: change.type, to: change.to };
		case "priority":
			return { change: "priority", to: priorityName(change.to) };
		case "assignee":
			return { change: "assignee", to: emailOf(directory, change.to) };
		case "project":
			return {
				change: "project",
				to: directory.projects.find((project) => project.id === change.to)?.name ?? null,
			};
		case "label":
			return {
				change: change.added ? "add_label" : "remove_label",
				to: directory.labels.find((label) => label.id === change.labelId)?.name ?? null,
			};
	}
}

function commentView(directory: Directory, comment: Comment): CommentOutput {
	return {
		author: emailOf(directory, comment.authorId),
		body: comment.body,
		createdAt: new Date(comment.createdAt).toISOString(),
		edited: comment.updatedAt > comment.createdAt,
	};
}

function emailOf(directory: Directory, memberId: string | null): string | null {
	if (memberId === null) return null;
	return directory.members.find((member) => member.id === memberId)?.email ?? null;
}
