/**
 * Domain entities as they exist on the wire and in the client store.
 * Server-only bookkeeping (field versions, soft-delete markers) never leaves the server.
 */

import type { IssueDisplay } from "./display";
import type { IssueFilters } from "./filters";

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
	"project",
] as const;
export type AgentChangeKind = (typeof AGENT_CHANGE_KINDS)[number];

/** Statuses that close an issue, which the `close` kind of change covers. */
export const CLOSED_STATUSES: readonly IssueStatus[] = ["done", "canceled"];

/**
 * The actor of the changes the server makes on its own, such as moving a completed cycle's
 * unfinished issues to the next one. It is never a member's id.
 */
export const SYSTEM_ACTOR_ID = "system";

/**
 * The actor of the changes a workspace's GitHub connection makes, such as moving an issue to Done
 * when the pull request that fixes it merges. It is never a member's id.
 */
export const GITHUB_ACTOR_ID = "github";

export interface Team {
	id: string;
	/** Short uppercase prefix for issue identifiers, e.g. `ENG` in `ENG-42`. */
	key: string;
	name: string;
	/** How the team's cycles run, or null when the team does not work in cycles. */
	cycles: CycleSettings | null;
	createdAt: number;
	updatedAt: number;
}

export interface CycleSettings {
	/** How long each cycle is, from 1 to 4 weeks. */
	weeks: number;
	/** The IANA time zone, such as `Europe/Istanbul`, whose midnights start and end the cycles. */
	timeZone: string;
}

/**
 * A time box for a team's issues. The server schedules cycles ahead, and completes each one once
 * its last day is over, moving its unfinished issues to the next. Days are `YYYY-MM-DD` in the
 * team's time zone.
 */
export interface Cycle {
	id: string;
	teamId: string;
	/** Sequential per team. */
	number: number;
	/** A name people gave it. Without one, it is called "Cycle" and its number. */
	name: string | null;
	/** Its first day. */
	startsOn: string;
	/** Its last day. */
	endsOn: string;
	/** When the server completed it. Issues join only cycles that have not completed. */
	completedAt: number | null;
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
	/** The project the issue belongs to, if any. */
	projectId: string | null;
	/** The cycle of its team that the issue is planned for, if any. */
	cycleId: string | null;
	/** The issue this one is part of, in any team of the workspace. Parents never form a cycle. */
	parentId: string | null;
	/** When work should start: `YYYY-MM-DD`, a calendar day with no time zone. */
	startDate: string | null;
	/** When it should be done: `YYYY-MM-DD`, a calendar day with no time zone. */
	dueDate: string | null;
	/** The size of the work in points, which the team decides the meaning of. */
	estimate: number | null;
	/** Ids of the issue's labels, in the order they were added. */
	labelIds: string[];
	/** Fractional index used for manual ordering. */
	sortOrder: string;
	/** Workspace version of the last write to this issue. Used as `baseVersion` for updates. */
	version: number;
	createdAt: number;
	updatedAt: number;
}

export const PROJECT_STATUSES = ["planned", "started", "paused", "completed", "canceled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A goal that groups issues across teams. Deleted projects leave the client store. */
export interface Project {
	id: string;
	name: string;
	description: string | null;
	status: ProjectStatus;
	/** A person member who leads the project. */
	leadId: string | null;
	/** `YYYY-MM-DD`, a real calendar date. */
	targetDate: string | null;
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
 * How two issues relate. `blocks` reads from `issueId` to `relatedIssueId`: the first blocks the
 * second. `duplicate` means `issueId` is a duplicate of `relatedIssueId`. `related` has no
 * direction.
 */
export const RELATION_TYPES = ["blocks", "duplicate", "related"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** A relation as seen from one of its two issues. */
export const RELATION_KINDS = [
	"blocks",
	"blocked_by",
	"duplicate_of",
	"duplicated_by",
	"related",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * A link between two live issues of the workspace, in any teams. Two issues have at most one
 * relation: making another replaces it. A relation goes when either issue is deleted.
 */
export interface IssueRelation {
	id: string;
	type: RelationType;
	issueId: string;
	relatedIssueId: string;
	creatorId: string;
	createdAt: number;
}

/** What `relation` is from `issueId`'s side, and the issue at its other end. */
export function relationFrom(
	relation: IssueRelation,
	issueId: string,
): { kind: RelationKind; otherId: string } {
	const outgoing = relation.issueId === issueId;
	const otherId = outgoing ? relation.relatedIssueId : relation.issueId;
	switch (relation.type) {
		case "blocks":
			return { kind: outgoing ? "blocks" : "blocked_by", otherId };
		case "duplicate":
			return { kind: outgoing ? "duplicate_of" : "duplicated_by", otherId };
		case "related":
			return { kind: "related", otherId };
	}
}

/** The relation that makes `issueId` relate to `otherId` as `kind` says. */
export function relationOf(
	kind: RelationKind,
	issueId: string,
	otherId: string,
): Pick<IssueRelation, "type" | "issueId" | "relatedIssueId"> {
	switch (kind) {
		case "blocks":
			return { type: "blocks", issueId, relatedIssueId: otherId };
		case "blocked_by":
			return { type: "blocks", issueId: otherId, relatedIssueId: issueId };
		case "duplicate_of":
			return { type: "duplicate", issueId, relatedIssueId: otherId };
		case "duplicated_by":
			return { type: "duplicate", issueId: otherId, relatedIssueId: issueId };
		case "related":
			return { type: "related", issueId, relatedIssueId: otherId };
	}
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
	| { type: "project"; from: string | null; to: string | null }
	| { type: "cycle"; from: string | null; to: string | null }
	| { type: "parent"; from: string | null; to: string | null }
	| { type: "startDate"; from: string | null; to: string | null }
	| { type: "dueDate"; from: string | null; to: string | null }
	| { type: "estimate"; from: number | null; to: number | null }
	| { type: "label"; labelId: string; added: boolean }
	/** Recorded on both issues, each from its own side. */
	| { type: "relation"; kind: RelationKind; issueId: string; added: boolean };

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
	/** The pull request or commit behind a change GitHub made. */
	source: ActivitySource | null;
	createdAt: number;
	updatedAt: number;
}

/** Where a change made through an integration came from. */
export interface ActivitySource {
	type: "pull_request" | "commit";
	/** How to show it, such as `gateweavehq/track#86` or `gateweavehq/track@1a2b3c4`. */
	label: string;
	url: string;
}

export const PULL_REQUEST_STATES = ["draft", "open", "merged", "closed"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * A pull request on GitHub that mentions issues of the workspace, as a GitHub connection last
 * reported it. The server writes these; clients never do. It links to the issues whose keys are
 * in its branch name, title or body, and when it merges it closes those named in its branch name
 * or after a closing word ("fixes", "closes", "resolves").
 */
export interface PullRequest {
	/** `github:` and GitHub's id for the pull request, which outlives renaming the repository. */
	id: string;
	/** `owner/name`. */
	repository: string;
	number: number;
	title: string;
	url: string;
	state: PullRequestState;
	branch: string;
	/** The GitHub login of whoever opened it. */
	author: string | null;
	issueIds: string[];
	/** The linked issues it moves to Done when it merges. */
	closingIssueIds: string[];
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
	| { type: "project"; to: string | null }
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

/** The ways a page of issues lays them out. */
export const ISSUE_LAYOUTS = ["list", "board", "calendar", "table", "timeline"] as const;
export type IssueLayout = (typeof ISSUE_LAYOUTS)[number];

/** Saved views a workspace holds at most, shared and personal together. */
export const MAX_VIEWS = 500;

/**
 * Filters and a layout under a name, for issues across the workspace. A shared view is the
 * workspace's: its creator and admins change it. A personal one is its owner's alone to change
 * and to see in the app, though, like every row, it reaches every member's replica.
 */
export interface SavedView {
	id: string;
	name: string;
	/** The member a personal view belongs to; null for a shared one. */
	ownerId: string | null;
	layout: IssueLayout;
	filters: IssueFilters;
	/** How the issues are grouped, ordered and shown. Null means the defaults. */
	display: IssueDisplay | null;
	creatorId: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * Whether a member hears of an issue's changes in their inbox. Private, like the inbox: only that
 * member's replica holds it. Unsubscribing keeps the row, so the member is not subscribed again
 * on their next comment; being assigned the issue subscribes them all the same.
 */
export interface Subscription {
	/** See {@link privateId}. */
	id: string;
	issueId: string;
	memberId: string;
	subscribed: boolean;
	updatedAt: number;
}

/** What brought an issue to a member's inbox, always someone else's doing. */
export type InboxEvent =
	/** The member was made the issue's assignee. */
	| { type: "assigned" }
	/** The member stopped being the issue's assignee. */
	| { type: "unassigned" }
	| { type: "comment"; commentId: string }
	| { type: "status"; from: IssueStatus; to: IssueStatus }
	/** An agent proposed a change, which waits for a person to accept or dismiss it. */
	| { type: "proposal"; proposalId: string; change: ProposedChange }
	/** Someone mentioned the member: in a comment, or in the description when it is null. */
	| { type: "mention"; commentId: string | null }
	/** The issue, assigned to the member, is due on `on` (`YYYY-MM-DD`). Track reminds them. */
	| { type: "due"; on: string };

/**
 * An issue in a member's inbox, private to them. There is one per issue, holding its newest
 * event; the issue's activity and comments tell the rest. A new event brings an archived or
 * snoozed item back.
 */
export interface InboxItem {
	/** See {@link privateId}. */
	id: string;
	issueId: string;
	memberId: string;
	event: InboxEvent;
	/**
	 * Who caused the event: a person, an agent, GitHub ({@link GITHUB_ACTOR_ID}), or Track
	 * ({@link SYSTEM_ACTOR_ID}) for a reminder.
	 */
	actorId: string;
	/** Events since the member last read the item; 0 when it is read. */
	unread: number;
	/** When the newest event happened. */
	updatedAt: number;
	/** Hidden from the inbox until then. */
	snoozedUntil: number | null;
	archivedAt: number | null;
}

/** The id of a member's private row about an issue: a subscription or an inbox item. */
export function privateId(issueId: string, memberId: string): string {
	return `${issueId}/${memberId}`;
}

export interface Entities {
	team: Team;
	issue: Issue;
	label: Label;
	project: Project;
	cycle: Cycle;
	comment: Comment;
	activity: Activity;
	proposal: Proposal;
	relation: IssueRelation;
	view: SavedView;
	member: Member;
	subscription: Subscription;
	inbox: InboxItem;
	pullRequest: PullRequest;
}
export type EntityName = keyof Entities;
export const ENTITY_NAMES = [
	"team",
	"issue",
	"label",
	"project",
	"cycle",
	"comment",
	"activity",
	"proposal",
	"relation",
	"view",
	"member",
	"subscription",
	"inbox",
	"pullRequest",
] as const satisfies readonly EntityName[];

/**
 * Entities that belong to one member. The server sends their rows and ops to that member alone,
 * so nobody's replica holds what a colleague subscribed to or read.
 */
export const PRIVATE_ENTITIES = ["subscription", "inbox"] as const satisfies readonly EntityName[];
export type PrivateEntityName = (typeof PRIVATE_ENTITIES)[number];

export function isPrivateEntity(entity: EntityName): entity is PrivateEntityName {
	return (PRIVATE_ENTITIES as readonly EntityName[]).includes(entity);
}
