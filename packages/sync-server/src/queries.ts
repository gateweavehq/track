import type { Issue, IssueStatus, Member, Team } from "@gateweave/track-protocol";
import { and, desc, eq, inArray, isNull, max, type SQL, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import { type Db, toIssue, toMember, toTeam } from "./state";

// Reads for server-side clients, which ask for a slice of the workspace instead of a replica.

export interface IssueQuery {
	teamId?: string | undefined;
	statuses?: readonly IssueStatus[] | undefined;
	/** A member's id, or null for unassigned issues. */
	assigneeId?: string | null | undefined;
	/** Matched against titles, ignoring case. */
	text?: string | undefined;
	limit: number;
}

export const MAX_QUERY_LIMIT = 200;

export interface Directory {
	teams: Team[];
	members: Member[];
}

export function readDirectory(db: Db): Directory {
	return {
		teams: db.select().from(schema.teams).orderBy(schema.teams.key).all().map(toTeam),
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

/** The largest sort order in use, so a new issue can go after every other one. */
export function lastSortOrder(db: Db): string | null {
	const row = db
		.select({ value: max(schema.issues.sortOrder) })
		.from(schema.issues)
		.where(isNull(schema.issues.deletedAt))
		.get();
	return row?.value ?? null;
}
