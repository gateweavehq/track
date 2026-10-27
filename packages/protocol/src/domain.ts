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

export const MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

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
	/** Fractional index used for manual ordering. */
	sortOrder: string;
	/** Workspace version of the last write to this issue. Used as `baseVersion` for updates. */
	version: number;
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
	/** Set when the user leaves the workspace; kept so historical references still resolve. */
	removedAt: number | null;
}

export interface Entities {
	team: Team;
	issue: Issue;
	member: Member;
}
export type EntityName = keyof Entities;
export const ENTITY_NAMES = ["team", "issue", "member"] as const satisfies readonly EntityName[];
