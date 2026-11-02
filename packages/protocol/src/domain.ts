/**
 * Domain entities as they exist on the wire and in the client store.
 * Server-only bookkeeping (field versions, soft-delete markers) never leaves the server.
 */

import type { IssueDisplay } from "./display";
import type { IssueFilters } from "./filters";
import type { TemplateRepeat } from "./repeat";
import type { WorkflowStatus } from "./statuses";

/** The key of one of a team's statuses: see `WorkflowStatus`. */
export type IssueStatus = string;

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
 * `close` is a change to a completed or canceled status; `status` covers every status change,
 * closing included. Creating an issue, commenting and managing labels are never proposed.
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

/**
 * The actor of the requests a team's public request form files, on behalf of someone who is not a
 * member. It is never a member's id.
 */
export const INTAKE_FORM_ACTOR_ID = "form";

/**
 * The actor of the requests sent to a team's intake email address, from someone who need not be
 * a member. It is never a member's id.
 */
export const INTAKE_EMAIL_ACTOR_ID = "email";

export interface Team {
	id: string;
	/** Short uppercase prefix for issue identifiers, e.g. `ENG` in `ENG-42`. */
	key: string;
	name: string;
	/** How the team's cycles run, or null when the team does not work in cycles. */
	cycles: CycleSettings | null;
	/**
	 * Archives the team's closed issues once no one has touched them for this many months
	 * (`AUTOMATION_MONTH_MS` each), or null for never.
	 */
	archiveAfterMonths: number | null;
	/**
	 * Closes the team's issues that are not started, into its first canceled status, once no one
	 * has touched them for this many months, or null for never.
	 */
	closeAfterMonths: number | null;
	/**
	 * The secret part of the link to the team's public request form, which files requests into its
	 * intake, or null when the form is off. The server makes a new one each time the form is
	 * turned on, so turning it off and on again retires the old link.
	 */
	intakeFormKey: string | null;
	/**
	 * The secret part of the team's intake email address, which files the email it gets into the
	 * team's intake, or null when it is off. Like the form's key, a new one each time it is turned on.
	 */
	intakeEmailKey: string | null;
	createdAt: number;
	updatedAt: number;
}

/** A month, for a team's automations: thirty days. */
export const AUTOMATION_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** The longest wait a team's automation takes, in months. */
export const MAX_AUTOMATION_MONTHS = 24;

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
	/** The key of one of its team's statuses. */
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
	/**
	 * When the issue was archived, or null. Only a closed issue is archived, and reopening it
	 * restores it. Archived issues leave lists and boards but stay in search, in history and in
	 * the progress of their project, cycle and parent.
	 */
	archivedAt: number | null;
	/**
	 * Whether the issue is a request waiting in its team's intake, for a person to accept into the
	 * team's workflow or decline. Requests leave lists and boards but stay in search.
	 */
	intake: boolean;
}

/**
 * What replicas keep of an archived issue: enough for links and relations by key, the archive
 * page, search by key and title, and the progress of its project, cycle and parent (in issues and
 * points). Its description, labels, comments, history, proposals and pull requests stay on the
 * server, so a large archive costs every browser nothing but these few fields.
 */
export const ARCHIVED_ISSUE_FIELDS = [
	"id",
	"teamId",
	"number",
	"title",
	"status",
	"projectId",
	"cycleId",
	"parentId",
	"estimate",
	"archivedAt",
] as const satisfies readonly (keyof Issue)[];

/** An archived issue as replicas hold it. */
export type ArchivedIssue = Pick<
	Issue,
	Exclude<(typeof ARCHIVED_ISSUE_FIELDS)[number], "archivedAt">
> & { archivedAt: number };

/** An issue that is not archived, whole. */
export type ActiveIssue = Issue & { archivedAt: null };

/** An issue as replicas hold it, in snapshots and ops: whole, or slim once archived. */
export type SyncedIssue = ActiveIssue | ArchivedIssue;

/** The issue as replicas get it: an archived one slimmed to `ARCHIVED_ISSUE_FIELDS`. */
export function toSyncedIssue(issue: Issue): SyncedIssue {
	const { archivedAt } = issue;
	if (archivedAt === null) return { ...issue, archivedAt };
	return {
		id: issue.id,
		teamId: issue.teamId,
		number: issue.number,
		title: issue.title,
		status: issue.status,
		projectId: issue.projectId,
		cycleId: issue.cycleId,
		parentId: issue.parentId,
		estimate: issue.estimate,
		archivedAt,
	};
}

/** Whether a replica's issue is whole, rather than an archived issue's slim row. */
export function isActiveIssue(issue: SyncedIssue): issue is ActiveIssue {
	return issue.archivedAt === null;
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

export const PROJECT_HEALTHS = ["on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof PROJECT_HEALTHS)[number];

/**
 * A post on how a project is going: its health as its author sees it, and what they have to say.
 * A project's updates are its history of how it went; the latest says how it is going now. Any
 * member posts them, agents included, and only the author edits one.
 */
export interface ProjectUpdate {
	id: string;
	projectId: string;
	authorId: string;
	health: ProjectHealth;
	/** Markdown. */
	body: string;
	createdAt: number;
	/** Later than `createdAt` once the update has been edited. */
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
	/** Archived, or restored: by hand, or by reopening the issue. */
	| { type: "archived"; archived: boolean }
	/** A request taken out of intake: accepted into the workflow, or declined. */
	| { type: "intake"; accepted: boolean }
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
	/**
	 * The linked issues it closes when it merges, moving them to Done or their team's first
	 * completed status.
	 */
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
	| { type: "label"; labelId: string; added: boolean }
	/**
	 * A decision on a request in intake: accepting it, in its status or `status`, or declining
	 * it, with the reply the agent drafted. Agents always propose these: only people decide.
	 */
	| {
			type: "intake";
			accepted: boolean;
			status: IssueStatus | null;
			reply: string | null;
	  };

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

/**
 * A team's starting point for new issues: the title, description, priority, labels and assignee
 * an issue made from it begins with. Anyone may change them before creating the issue. A template
 * with a schedule also makes an issue on its own on each day the schedule falls on.
 */
export interface IssueTemplate {
	id: string;
	teamId: string;
	/** What people pick it by, unique in its team, ignoring case. */
	name: string;
	/** The new issue's title, or empty for the person to write one. */
	title: string;
	description: string | null;
	priority: IssuePriority;
	/** Labels deleted since leave the template with them. */
	labelIds: string[];
	/** Someone who has since left the workspace is not assigned. */
	assigneeId: string | null;
	/** When it makes issues on its own, or null when only people use it. */
	repeat: TemplateRepeat | null;
	/**
	 * The day it makes its next issue, in the schedule's time zone, or null without a schedule.
	 * The server sets it.
	 */
	nextOn: string | null;
	createdAt: number;
	updatedAt: number;
}

/** Templates a team holds at most. */
export const MAX_TEMPLATES_PER_TEAM = 50;

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
	| { type: "due"; on: string }
	/** Someone took the request out of its team's intake: accepted it, or declined it. */
	| { type: "intake"; accepted: boolean };

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
	status: WorkflowStatus;
	issue: SyncedIssue;
	label: Label;
	project: Project;
	projectUpdate: ProjectUpdate;
	cycle: Cycle;
	comment: Comment;
	activity: Activity;
	proposal: Proposal;
	relation: IssueRelation;
	view: SavedView;
	template: IssueTemplate;
	member: Member;
	subscription: Subscription;
	inbox: InboxItem;
	pullRequest: PullRequest;
}
export type EntityName = keyof Entities;
export const ENTITY_NAMES = [
	"team",
	"status",
	"issue",
	"label",
	"project",
	"projectUpdate",
	"cycle",
	"comment",
	"activity",
	"proposal",
	"relation",
	"view",
	"template",
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
