/**
 * Domain entities as they exist on the wire and in the client store.
 * Server-only bookkeeping (field versions, soft-delete markers) never leaves the server.
 */

export const ISSUE_STATUSES = [
	"backlog",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"canceled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** 0 = no priority, then 1 (urgent) through 4 (low). */
export const ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/**
 * `agent` is a member an admin created for an AI agent. It works through the same mutations as a
 * member and never signs in: it reaches the workspace with a key, over MCP.
 */
export const MEMBER_ROLES = ["owner", "admin", "member", "agent"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
/** The roles a person can be invited with or given. */
export type PersonRole = Exclude<MemberRole, "agent">;

/** Owners and admins manage teams, labels, members and agents. */
export function isAdminRole(role: MemberRole): boolean {
	return role === "owner" || role === "admin";
}

/**
 * Kinds of change to an issue that an admin can have an agent member propose rather than make.
 * `close` is a status change to done or canceled; `status` covers every status change, closing
 * included. Creating an issue, commenting and managing labels are never proposed.
 */
export const AGENT_CHANGE_KINDS = [
	"title",
	"description",
	"status",
	"close",
	"priority",
	"assignee",
	"labels",
] as const;
export type AgentChangeKind = (typeof AGENT_CHANGE_KINDS)[number];

/** Statuses that close an issue, which the `close` kind of change covers. */
export const CLOSED_STATUSES: readonly IssueStatus[] = ["done", "canceled"];

export interface Team {
	id: string;
	/** Short uppercase prefix for issue identifiers, e.g. `ENG` in `ENG-42`. */
	key: string;
	name: string;
	createdAt: number;
	updatedAt: number;
}

export interface Issue {
	id: string;
	teamId: string;
	/** Sequential per team; assigned by the server. */
	number: number;
	title: string;
	description: string | null;
	status: IssueStatus;
	priority: IssuePriority;
	assigneeId: string | null;
	creatorId: string;
	/** Ids of the issue's labels, in the order they were added. */
	labelIds: string[];
	/** Fractional index used for manual ordering. */
	sortOrder: string;
	/** Workspace version of the last write to this issue. Used as `baseVersion` for updates. */
	version: number;
	createdAt: number;
	updatedAt: number;
}

/** A workspace-wide tag for issues, such as "Bug". Names are unique, ignoring case. */
export interface Label {
	id: string;
	name: string;
	/** `#rrggbb`, lowercase. */
	color: string;
	createdAt: number;
	updatedAt: number;
}

export const MAX_LABELS_PER_ISSUE = 20;

/** A comment on an issue. Only its author can edit it. */
export interface Comment {
	id: string;
	issueId: string;
	authorId: string;
	body: string;
	createdAt: number;
	/** Later than `createdAt` once the comment has been edited. */
	updatedAt: number;
}

/**
 * What an activity entry records. Members and labels are referenced by id. Creation is not an
 * entry: an issue's `creatorId` and `createdAt` already say it.
 */
export type ActivityChange =
	| { type: "title"; from: string; to: string }
	| { type: "description" }
	| { type: "status"; from: IssueStatus; to: IssueStatus }
	| { type: "priority"; from: IssuePriority; to: IssuePriority }
	| { type: "assignee"; from: string | null; to: string | null }
	| { type: "label"; labelId: string; added: boolean };

/**
 * An entry in an issue's history. The server writes these as a side effect of issue mutations;
 * clients never write them. Quick successive changes to one field by one person are merged into
 * a single entry, so `updatedAt` moves while `createdAt` keeps the entry's place in the history.
 */
export interface Activity {
	id: string;
	issueId: string;
	actorId: string;
	change: ActivityChange;
	/** The agent whose proposal this was, when the actor accepted one. */
	proposedBy: string | null;
	createdAt: number;
	updatedAt: number;
}

/** A change an agent proposed. Labels are proposed one at a time, as they are added. */
export type ProposedChange =
	| { type: "title"; to: string }
	| { type: "description"; to: string | null }
	| { type: "status"; to: IssueStatus }
	| { type: "priority"; to: IssuePriority }
	| { type: "assignee"; to: string | null }
	| { type: "label"; labelId: string; added: boolean };

/**
 * A change an agent member was set to propose instead of make. It waits on the issue until a
 * person accepts it, which makes the change as them, or dismisses it. Only open proposals reach
 * clients. An agent has at most one open proposal per field of an issue (per label, for
 * labels): proposing again replaces it.
 */
export interface Proposal {
	id: string;
	issueId: string;
	/** The agent member who proposed it. */
	agentId: string;
	change: ProposedChange;
	createdAt: number;
	updatedAt: number;
}

export interface Member {
	/** The user's id. */
	id: string;
	name: string;
	email: string;
	image: string | null;
	role: MemberRole;
	/**
	 * For an agent, the kinds of change it proposes instead of making, as an admin set them with
	 * `agent.update`. Always empty for people.
	 */
	proposes: AgentChangeKind[];
	/** Set when the user leaves the workspace; kept so historical references still resolve. */
	removedAt: number | null;
}

export interface Entities {
	team: Team;
	issue: Issue;
	label: Label;
	comment: Comment;
	activity: Activity;
	proposal: Proposal;
	member: Member;
}
export type EntityName = keyof Entities;
export const ENTITY_NAMES = [
	"team",
	"issue",
	"label",
	"comment",
	"activity",
	"proposal",
	"member",
] as const satisfies readonly EntityName[];
