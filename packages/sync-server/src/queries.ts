import type { Comment, Issue, IssueStatus, Label, Member, Team } from "@gateweave/track-protocol";
import { and, asc, desc, eq, inArray, isNull, max, type SQL, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import { type Db, toComment, toIssue, toLabel, toMember, toTeam } from "./state";

// Reads for server-side clients, which ask for a slice of the workspace instead of a replica.

export interface IssueQuery {
	teamId?: string | undefined;
	statuses?: readonly IssueStatus[] | undefined;
	/** A member's id, or null for unassigned issues. */
	assigneeId?: string | null | undefined;
	/** Only issues with this label. */
	labelId?: string | undefined;
	/** Matched against titles, ignoring case. */
	text?: string | undefined;
	limit: number;
}

export const MAX_QUERY_LIMIT = 200;

export interface Directory {
	teams: Team[];
	labels: Label[];
	members: Member[];
}

export function readDirectory(db: Db): Directory {
	return {
		teams: db.select().from(schema.teams).orderBy(schema.teams.key).all().map(toTeam),
		labels: db
			.select()
			.from(schema.labels)
			.where(isNull(schema.labels.deletedAt))
			.orderBy(schema.labels.name)
			.all()
			.map(toLabel),
		members: db.select().from(schema.members).orderBy(schema.members.name).all().map(toMember),
	};
}

/** Live issues matching every given filter, most recently updated first. */
export function findIssues(db: Db, query: IssueQuery): Issue[] {
	const filters: SQL[] = [isNull(schema.issues.deletedAt)];
	if (query.teamId !== undefined) filters.push(eq(schema.issues.teamId, query.teamId));
	if (query.statuses?.length) filters.push(inArray(schema.issues.status, [...query.statuses]));
	if (query.assigneeId === null) filters.push(isNull(schema.issues.assigneeId));
	else if (query.assigneeId !== undefined) {
		filters.push(eq(schema.issues.assigneeId, query.assigneeId));
	}
	if (query.labelId !== undefined) {
		filters.push(
			sql`exists (select 1 from json_each(${schema.issues.labelIds}) where value = ${query.labelId})`,
		);
	}
	const text = query.text?.trim();
	// instr instead of LIKE, so % and _ in the text are not wildcards. lower() folds ASCII only.
	if (text) filters.push(sql`instr(lower(${schema.issues.title}), lower(${text})) > 0`);

	return db
		.select()
		.from(schema.issues)
		.where(and(...filters))
		.orderBy(desc(schema.issues.updatedAt), schema.issues.id)
		.limit(Math.min(Math.max(Math.trunc(query.limit), 1), MAX_QUERY_LIMIT))
		.all()
		.map(toIssue);
}

export function findIssueById(db: Db, id: string): Issue | undefined {
	const row = db
		.select()
		.from(schema.issues)
		.where(and(eq(schema.issues.id, id), isNull(schema.issues.deletedAt)))
		.get();
	return row && toIssue(row);
}

/** A live issue by its human-readable key, such as `ENG` and 42 for `ENG-42`. */
export function findIssueByKey(db: Db, teamKey: string, number: number): Issue | undefined {
	const row = db
		.select({ issue: schema.issues })
		.from(schema.issues)
		.innerJoin(schema.teams, eq(schema.issues.teamId, schema.teams.id))
		.where(
			and(
				eq(schema.teams.key, teamKey),
				eq(schema.issues.number, number),
				isNull(schema.issues.deletedAt),
			),
		)
		.get();
	return row && toIssue(row.issue);
}

/** A live issue's comments, oldest first. Empty for a deleted or unknown issue. */
export function findComments(db: Db, issueId: string): Comment[] {
	if (!findIssueById(db, issueId)) return [];
	return db
		.select()
		.from(schema.comments)
		.where(and(eq(schema.comments.issueId, issueId), isNull(schema.comments.deletedAt)))
		.orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
		.all()
		.map(toComment);
}

/** The largest sort order in use, so a new issue can go after every other one. */
export function lastSortOrder(db: Db): string | null {
	const row = db
		.select({ value: max(schema.issues.sortOrder) })
		.from(schema.issues)
		.where(isNull(schema.issues.deletedAt))
		.get();
	return row?.value ?? null;
}
