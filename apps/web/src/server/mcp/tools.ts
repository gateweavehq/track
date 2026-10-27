import {
	ISSUE_STATUSES,
	type Issue,
	type IssuePriority,
	MEMBER_ROLES,
	type Member,
	type MutationInput,
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
const assigneeInput = z
	.string()
	.min(1)
	.describe('"me", "none", or a member\'s email or id, from get_workspace.');

const issueSummary = z.object({
	key: z.string(),
	title: z.string(),
	status: statusInput,
	priority: priorityInput,
	assignee: z.string().nullable().describe("The assignee's email."),
	url: z.string(),
	updatedAt: z.string(),
});
const issueDetail = issueSummary.extend({
	description: z.string().nullable().describe("Markdown."),
	creator: z.string().nullable().describe("The creator's email."),
	createdAt: z.string(),
});
type IssueSummary = z.infer<typeof issueSummary>;
type IssueDetail = z.infer<typeof issueDetail>;

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
			outputSchema: z.object({
				workspaces: z.array(
					z.object({ slug: z.string(), name: z.string(), role: z.enum(MEMBER_ROLES) }),
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
				"Lists a workspace's teams (whose keys prefix issue keys) and its members (who can be assignees).",
			inputSchema: z.object({ workspace: workspaceInput }),
			outputSchema: z.object({
				teams: z.array(z.object({ key: z.string(), name: z.string() })),
				members: z.array(
					z.object({
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
				const { teams, members } = await (await open(access, workspace)).directory();
				return {
					teams: teams.map(({ key, name }) => ({ key, name })),
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
				"Finds issues in a workspace, most recently updated first. Every filter is optional.",
			inputSchema: z.object({
				workspace: workspaceInput,
				team: z.string().optional().describe("A team key, such as ENG."),
				status: z.array(statusInput).optional().describe("Any of these statuses."),
				assignee: assigneeInput.optional(),
				text: z.string().max(200).optional().describe("Words in the title."),
				limit: z.number().int().min(1).max(200).default(50),
			}),
			outputSchema: z.object({ issues: z.array(issueSummary) }),
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
			description: "Reads one issue, including its description.",
			inputSchema: z.object({ workspace: workspaceInput, key: keyInput }),
			outputSchema: issueDetail,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ workspace: slug, key }) =>
			run(async () => {
				const workspace = await open(access, slug);
				const directory = await workspace.directory();
				return detail(access, workspace, directory, await findIssue(workspace, key));
			}),
	);

	server.registerTool(
		"create_issue",
		{
			title: "Create issue",
			description: "Creates an issue in a team. It goes to the end of the manual order.",
			inputSchema: z.object({
				workspace: workspaceInput,
				team: z.string().describe("The team's key, such as ENG."),
				title: z.string().trim().min(1).max(512),
				description: z.string().max(100_000).optional().describe("Markdown."),
				status: statusInput.default("backlog"),
				priority: priorityInput.default("none"),
				assignee: assigneeInput.optional(),
			}),
			outputSchema: issueDetail,
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		(input) =>
			run(async () => {
				const workspace = await open(access, input.workspace);
				const directory = await workspace.directory();
				const id = uuidv7();
				await apply(workspace, {
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
						sortOrder: generateKeyBetween(await workspace.lastSortOrder(), null),
					},
				});
				return detail(access, workspace, directory, await reread(workspace, id));
			}),
	);

	server.registerTool(
		"update_issue",
		{
			title: "Update issue",
			description:
				"Changes an issue's title, description, status, priority or assignee. Fields you leave out stay as they are.",
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
			}),
			outputSchema: issueDetail,
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
				};
				if (Object.keys(patch).length === 0) throw new ToolError("Nothing to change.");
				// The issue was read just now, so only an edit landing in between can conflict.
				await apply(workspace, {
					name: "issue.update",
					args: { id: issue.id, baseVersion: issue.version, patch },
				});
				return detail(access, workspace, directory, await reread(workspace, issue.id));
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

async function apply(workspace: WorkspaceAccess, mutation: MutationInput): Promise<void> {
	const result = await workspace.mutate(mutation);
	if (result.ok) return;
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

function emailOf(directory: Directory, memberId: string | null): string | null {
	if (memberId === null) return null;
	return directory.members.find((member) => member.id === memberId)?.email ?? null;
}
