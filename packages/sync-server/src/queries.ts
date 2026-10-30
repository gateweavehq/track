import type {
	Comment,
	Cycle,
	Issue,
	IssueRelation,
	IssueStatus,
	Label,
	Member,
	Project,
	Team,
} from "@gateweave/track-protocol";
import { and, asc, desc, eq, inArray, isNull, max, or, type SQL, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import { issueSearch, issueSearchDocs, matchExpression, matches, RANK } from "./search";
import {
	type Db,
	toComment,
	toCycle,
	toIssue,
	toLabel,
	toMember,
	toProject,
	toRelation,
	toTeam,
} from "./state";

// Reads for server-side clients, which ask for a slice of the workspace instead of a replica.

export interface IssueQuery {
	teamId?: string | undefined;
	statuses?: readonly IssueStatus[] | undefined;
	/** A member's id, or null for unassigned issues. */
	assigneeId?: string | null | undefined;
	/** Only issues in this project. */
	projectId?: string | undefined;
	/** Only issues in any of these cycles. */
	cycleIds?: readonly string[] | undefined;
	/** Only the sub-issues of this issue. */
	parentId?: string | undefined;
	/** Only issues with this label. */
	labelId?: string | undefined;
	/**
	 * Words to find in the key, title, description or comments; each must start a word there,
	 * ignoring case and diacritics. Matches come best first. See `search.ts`.
	 */
	text?: string | undefined;
	limit: number;
}

export const MAX_QUERY_LIMIT = 200;

export interface Directory {
	teams: Team[];
	labels: Label[];
	projects: Project[];
	/** Every team's cycles, in order. */
	cycles: Cycle[];
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
		projects: db
			.select()
			.from(schema.projects)
			.where(isNull(schema.projects.deletedAt))
			.orderBy(schema.projects.name)
			.all()
			.map(toProject),
		cycles: db
			.select()
			.from(schema.cycles)
			.orderBy(schema.cycles.teamId, schema.cycles.number)
			.all()
			.map(toCycle),
		members: db.select().from(schema.members).orderBy(schema.members.name).all().map(toMember),
	};
}

/** Live issues matching every given filter: best text match first, then most recently updated. */
export function findIssues(db: Db, query: IssueQuery): Issue[] {
	const filters: SQL[] = [isNull(schema.issues.deletedAt)];
	if (query.teamId !== undefined) filters.push(eq(schema.issues.teamId, query.teamId));
	if (query.statuses?.length) filters.push(inArray(schema.issues.status, [...query.statuses]));
	if (query.assigneeId === null) filters.push(isNull(schema.issues.assigneeId));
	else if (query.assigneeId !== undefined) {
		filters.push(eq(schema.issues.assigneeId, query.assigneeId));
	}
	if (query.projectId !== undefined) filters.push(eq(schema.issues.projectId, query.projectId));
	if (query.cycleIds !== undefined) {
		filters.push(
			query.cycleIds.length > 0 ? inArray(schema.issues.cycleId, [...query.cycleIds]) : sql`0`,
		);
	}
	if (query.parentId !== undefined) filters.push(eq(schema.issues.parentId, query.parentId));
	if (query.labelId !== undefined) {
		filters.push(
			sql`exists (select 1 from json_each(${schema.issues.labelIds}) where value = ${query.labelId})`,
		);
	}
	const limit = Math.min(Math.max(Math.trunc(query.limit), 1), MAX_QUERY_LIMIT);

	const text = query.text?.trim();
	if (!text) {
		return db
			.select()
			.from(schema.issues)
			.where(and(...filters))
			.orderBy(desc(schema.issues.updatedAt), schema.issues.id)
			.limit(limit)
			.all()
			.map(toIssue);
	}

	// Text without a single word, such as "?!", has nothing to match.
	const expression = matchExpression(text);
	if (!expression) return [];
	return db
		.select({ issue: schema.issues })
		.from(issueSearch)
		.innerJoin(issueSearchDocs, eq(issueSearchDocs.id, issueSearch.rowid))
		.innerJoin(schema.issues, eq(schema.issues.id, issueSearchDocs.issueId))
		.where(and(matches(expression), ...filters))
		.orderBy(RANK, desc(schema.issues.updatedAt), schema.issues.id)
		.limit(limit)
		.all()
		.map(({ issue }) => toIssue(issue));
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

/** A live issue's relations, oldest first, from either side. */
export function findRelations(db: Db, issueId: string): IssueRelation[] {
	return db
		.select()
		.from(schema.relations)
		.where(or(eq(schema.relations.issueId, issueId), eq(schema.relations.relatedIssueId, issueId)))
		.orderBy(asc(schema.relations.createdAt), asc(schema.relations.id))
		.all()
		.map(toRelation);
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
