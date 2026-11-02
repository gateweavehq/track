import {
	type Activity,
	type Comment,
	type Cycle,
	compareStatuses,
	type Issue,
	type IssueRelation,
	type IssueStatus,
	type IssueTemplate,
	type Label,
	type Member,
	type Project,
	type ProjectHealth,
	type ProjectUpdate,
	type PullRequest,
	type Team,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	max,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import * as schema from "./db/schema";
import {
	commentMatches,
	issueSearch,
	issueSearchDocs,
	matchExpression,
	matches,
	RANK,
} from "./search";
import {
	type Db,
	toActivity,
	toComment,
	toCycle,
	toIssue,
	toLabel,
	toMember,
	toProject,
	toProjectUpdate,
	toPullRequest,
	toRelation,
	toStatus,
	toTeam,
	toTemplate,
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
	/** Only archived issues, or only the others. Left out, both. */
	archived?: boolean | undefined;
	/** Only requests in intake, or only the others. Left out, both. */
	intake?: boolean | undefined;
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
	/** Every team's statuses in its order, removed ones too, as history still names them. */
	statuses: WorkflowStatus[];
	labels: Label[];
	projects: Project[];
	/** Every team's cycles, in order. */
	cycles: Cycle[];
	members: Member[];
	/** Every team's issue templates, by name. */
	templates: IssueTemplate[];
	/** Each project's health, as its latest update says it, by project id. */
	projectHealth: Record<string, ProjectHealth>;
}

export function readDirectory(db: Db): Directory {
	const projectHealth: Record<string, ProjectHealth> = {};
	const updates = db
		.select({ projectId: schema.projectUpdates.projectId, health: schema.projectUpdates.health })
		.from(schema.projectUpdates)
		.where(isNull(schema.projectUpdates.deletedAt))
		.orderBy(asc(schema.projectUpdates.createdAt), asc(schema.projectUpdates.id))
		.all();
	// Oldest first, so the latest of each project is the one left.
	for (const update of updates) projectHealth[update.projectId] = update.health;
	return {
		teams: db.select().from(schema.teams).orderBy(schema.teams.key).all().map(toTeam),
		statuses: db.select().from(schema.statuses).all().map(toStatus).sort(compareStatuses),
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
		templates: db
			.select()
			.from(schema.templates)
			.orderBy(schema.templates.teamId, schema.templates.name)
			.all()
			.map(toTemplate),
		projectHealth,
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
	if (query.archived !== undefined) {
		filters.push(
			query.archived ? isNotNull(schema.issues.archivedAt) : isNull(schema.issues.archivedAt),
		);
	}
	if (query.intake !== undefined) filters.push(eq(schema.issues.intake, query.intake));
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
	const found = db
		.select({ issue: schema.issues })
		.from(issueSearch)
		.innerJoin(issueSearchDocs, eq(issueSearchDocs.id, issueSearch.rowid))
		.innerJoin(schema.issues, eq(schema.issues.id, issueSearchDocs.issueId))
		.where(and(matches(expression), ...filters))
		.orderBy(RANK, desc(schema.issues.updatedAt), schema.issues.id)
		.limit(limit)
		.all()
		.map(({ issue }) => issue);
	if (found.length === limit) return found.map(toIssue);

	// Then the issues whose comments are indexed apart, past the size an issue's row holds, that
	// match only with their comments' help: almost always none. Their scores come from another
	// table, whose word frequencies differ, so they follow the others rather than mix in.
	const apart = [...commentMatches(db, text)].sort(([, a], [, b]) => a - b);
	for (const [id] of apart) {
		if (found.length === limit) break;
		const issue = db
			.select()
			.from(schema.issues)
			.where(and(eq(schema.issues.id, id), ...filters))
			.get();
		if (issue) found.push(issue);
	}
	return found.map(toIssue);
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

/** Whose issues insights are worked out over: one team's, or one project's from any team. */
export type InsightScope = { teamId: string } | { projectId: string };

/**
 * What insights are worked out from: the live issues of a team or a project, archived ones too,
 * and their status changes, the only history insights read.
 */
export function findInsightSource(
	db: Db,
	scope: InsightScope,
): { issues: Issue[]; activities: Activity[] } {
	const inScope =
		"teamId" in scope
			? eq(schema.issues.teamId, scope.teamId)
			: eq(schema.issues.projectId, scope.projectId);
	const issues = db
		.select()
		.from(schema.issues)
		.where(and(inScope, isNull(schema.issues.deletedAt)))
		.all()
		.map(toIssue);
	const activities = db
		.select({ activity: schema.activities })
		.from(schema.activities)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.activities.issueId))
		.where(
			and(
				inScope,
				isNull(schema.issues.deletedAt),
				sql`json_extract(${schema.activities.change}, '$.type') = 'status'`,
			),
		)
		.all()
		.map(({ activity }) => toActivity(activity));
	return { issues, activities };
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

/** A live project's updates, the latest first. */
export function findProjectUpdates(db: Db, projectId: string): ProjectUpdate[] {
	return db
		.select({ update: schema.projectUpdates })
		.from(schema.projectUpdates)
		.innerJoin(schema.projects, eq(schema.projects.id, schema.projectUpdates.projectId))
		.where(
			and(
				eq(schema.projectUpdates.projectId, projectId),
				isNull(schema.projectUpdates.deletedAt),
				isNull(schema.projects.deletedAt),
			),
		)
		.orderBy(desc(schema.projectUpdates.createdAt), desc(schema.projectUpdates.id))
		.all()
		.map(({ update }) => toProjectUpdate(update));
}

/** The pull requests that mention a live issue, oldest first. */
export function findPullRequests(db: Db, issueId: string): PullRequest[] {
	if (!findIssueById(db, issueId)) return [];
	const { issueIds } = schema.pullRequests;
	return db
		.select()
		.from(schema.pullRequests)
		.where(sql`exists (select 1 from json_each(${issueIds}) where value = ${issueId})`)
		.orderBy(asc(schema.pullRequests.createdAt), asc(schema.pullRequests.id))
		.all()
		.map(toPullRequest);
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
