// The guided start: a new workspace's first team and a few issues that show Track by doing. Pure:
// no Worker APIs, so the steps can be tested on their own.
import type { IssuePriority, IssueStatus, MutationInput } from "@gateweave/track-protocol";
import { generateNKeysBetween } from "fractional-indexing";
import { suggestKey } from "#/lib/teams";

interface GuideIssue {
	title: string;
	description: string;
	status: IssueStatus;
	priority: IssuePriority;
}

export interface GuideOptions {
	/** The workspace, whose name the team takes. */
	workspace: { id: string; name: string };
	/** The admin who asked for it, who gets the issues. */
	ownerId: string;
	/** Where agents connect, or null when this server has no MCP endpoint. */
	mcpUrl: string | null;
	/** A fresh entity id. */
	newId: () => string;
}

/** The team's key when its name gives none, as "123" does. */
const FALLBACK_KEY = "TEAM";

/**
 * The guided team's id. It is the same every time for a workspace, so asking twice cannot add a
 * second team: the Durable Object refuses an id it already has.
 */
export function guideTeamId(workspaceId: string): string {
	return `guide-${workspaceId}`.slice(0, 64);
}

/** The team, then its issues in the order they are listed. */
export function guideSteps({ workspace, ownerId, mcpUrl, newId }: GuideOptions): {
	teamKey: string;
	mutations: MutationInput[];
} {
	const teamId = guideTeamId(workspace.id);
	const teamKey = suggestKey(workspace.name) || FALLBACK_KEY;
	const issues = guideIssues(mcpUrl);
	const sortOrders = generateNKeysBetween(null, null, issues.length);
	return {
		teamKey,
		mutations: [
			{
				name: "team.create",
				args: { id: teamId, key: teamKey, name: workspace.name.trim().slice(0, 64) },
			},
			...issues.map(
				(issue, index): MutationInput => ({
					name: "issue.create",
					args: {
						id: newId(),
						teamId,
						title: issue.title,
						description: issue.description,
						status: issue.status,
						priority: issue.priority,
						assigneeId: ownerId,
						projectId: null,
						labelIds: [],
						sortOrder: sortOrders[index] ?? "",
					},
				}),
			),
		],
	};
}

function guideIssues(mcpUrl: string | null): GuideIssue[] {
	return [
		{
			title: "Welcome to Track",
			description: lines(
				"These issues show you around. They are ordinary issues: try what each one says, then close it, or delete them all when you are done.",
				"",
				"Everything you change saves as you type and reaches everyone in the workspace at once. Track keeps a copy of the workspace on this device, so it opens instantly and keeps working without a connection.",
			),
			status: "in_progress",
			priority: 2,
		},
		{
			title: "Press C to create an issue",
			description: lines(
				"Press C anywhere in the workspace, or use New issue in the sidebar. A title is enough; status, priority, assignee, labels and project can come later.",
				"",
				"On an issue, S changes its status, P its priority and A its assignee. Esc goes back to the list.",
			),
			status: "todo",
			priority: 3,
		},
		{
			title: "Search and run commands with Ctrl K (⌘K on a Mac)",
			description: lines(
				"The command palette finds issues by key, title, description and comments, opens teams and projects, and runs any command.",
				"",
				"Press ? to see every keyboard shortcut. Track works without a mouse.",
			),
			status: "todo",
			priority: 3,
		},
		{
			title: "Move issues around the board",
			description: lines(
				"Ctrl B (⌘B on a Mac) switches between the list and the board. Drag an issue to another column or another place in its column.",
				"",
				"From the keyboard: J and K select the next and previous issue, H and L change column, and Alt with an arrow key moves the selected issue. Press / to filter.",
			),
			status: "todo",
			priority: 3,
		},
		{
			title: "Invite your team",
			description: lines(
				"Admins invite people from Settings, then Members, with a link (or by email, where the server sends email), and choose whether they join as members or admins.",
				"",
				"People see each other's changes as they happen. Someone removed from the workspace loses access at once, and their browser forgets it.",
			),
			status: "backlog",
			priority: 4,
		},
		{
			title: "Group work with labels and projects",
			description: lines(
				"Labels are shared by every team: manage them in Settings, then Labels, and press L on an issue to add some.",
				"",
				"Projects gather issues from any team toward a goal, with a lead, a status, a target date and their progress. Find them under Projects in the sidebar.",
			),
			status: "backlog",
			priority: 4,
		},
		{
			title: "Connect an AI agent",
			description: mcpUrl
				? lines(
						`Track is an MCP server, so AI agents can search, read, create and update issues as you, after you approve them. Point any MCP client at ${mcpUrl}, for example:`,
						"",
						`claude mcp add --transport http gateweave-track ${mcpUrl}`,
						"",
						"Agents that work on their own can join the workspace as members, from Settings, then Agents. You choose which kinds of change they only propose, for a person to accept.",
					)
				: lines(
						"Track is an MCP server, so AI agents can search, read, create and update issues as you, after you approve them.",
						"",
						"This server has no fixed address yet, so its MCP endpoint is off. Whoever runs it can turn it on by setting BETTER_AUTH_URL; see docs/self-hosting.md in the Track repository.",
					),
			status: "backlog",
			priority: 4,
		},
		{
			title: "Install Track and try it offline",
			description: lines(
				"Install Track from the browser's address bar on a computer, or with Add to Home Screen on a phone. It opens on the workspace you used last.",
				"",
				"Turn off your connection and keep working: changes wait on this device and are sent when you are back online.",
			),
			status: "backlog",
			priority: 4,
		},
	];
}

function lines(...text: string[]): string {
	return text.join("\n");
}
