import {
	ARCHIVE_PAGE_BUDGET,
	type ArchivedIssues,
	type ArchivedIssuesPage,
	type IssueDetails,
} from "@gateweave/track-protocol";
import {
	and,
	asc,
	type Column,
	eq,
	getTableColumns,
	gt,
	isNotNull,
	isNull,
	type SQL,
	sql,
} from "drizzle-orm";
import * as schema from "./db/schema";
import { type ChangeSet, onlyArchived } from "./log";
import { type Db, toActivity, toComment, toIssue, toProposal, toPullRequest } from "./state";

/**
 * Keeps replicas in step when an issue is archived or restored. Replicas hold an archived issue
 * as a slim row, without its comments, history, proposals or pull requests (`ChangeSet.put` sends
 * it slim and turns later writes to those into deletes). So archiving deletes what they hold of
 * it, and restoring sends it all back, as ordinary ops. Call it after the issue's own op.
 */
export function syncArchive(
	db: Db,
	changes: ChangeSet,
	previous: Pick<schema.IssueRow, "archivedAt">,
	row: Pick<schema.IssueRow, "id" | "archivedAt">,
): void {
	const was = previous.archivedAt !== null;
	const is = row.archivedAt !== null;
	if (was === is) return;
	const { comments, activities, proposals, pullRequests } = rowsOf(db, row.id);

	if (is) {
		for (const comment of comments) changes.delete("comment", comment.id);
		for (const activity of activities) changes.delete("activity", activity.id);
		for (const proposal of proposals) changes.delete("proposal", proposal.id);
		// A pull request that also mentions an issue still in replicas stays, for that one.
		for (const pullRequest of pullRequests) {
			if (onlyArchived(db, "pullRequest", toPullRequest(pullRequest))) {
				changes.delete("pullRequest", pullRequest.id);
			}
		}
		return;
	}
	for (const comment of comments) changes.put("comment", toComment(comment));
	for (const activity of activities) changes.put("activity", toActivity(activity));
	for (const proposal of proposals) changes.put("proposal", toProposal(proposal));
	for (const pullRequest of pullRequests) changes.put("pullRequest", toPullRequest(pullRequest));
}

/**
 * A live issue whole, with its comments, history, open proposals and pull requests: what a
 * replica leaves out of an archived issue, for its page. Undefined for a deleted or unknown id,
 * which includes every other workspace's issues, since each workspace has a database of its own.
 * Reads only, so nothing reaches a replica.
 */
export function findIssueDetails(db: Db, issueId: string): IssueDetails | undefined {
	const row = db
		.select()
		.from(schema.issues)
		.where(and(eq(schema.issues.id, issueId), isNull(schema.issues.deletedAt)))
		.get();
	if (!row) return undefined;
	const rows = rowsOf(db, issueId);
	return {
		issue: toIssue(row),
		comments: rows.comments.map(toComment),
		activities: rows.activities.map(toActivity),
		proposals: rows.proposals.map(toProposal),
		pullRequests: rows.pullRequests.map(toPullRequest),
	};
}

/**
 * Every live archived issue whole, or one team's, with their comments and history, in one answer,
 * for the exports of v0.21.0, which do not ask for pages. Exactly as that build read it, until a
 * later `PROTOCOL_VERSION` bump retires it. An archive too large for one answer is `"too_large"`,
 * never part of it, so that build shows its error rather than saving a short file; newer clients
 * read `findArchivedIssuesPage`. Reads only.
 */
export function findArchivedIssues(db: Db, teamId: string | null): ArchivedIssues | "too_large" {
	const filters: SQL[] = [isNull(schema.issues.deletedAt), isNotNull(schema.issues.archivedAt)];
	if (teamId !== null) filters.push(eq(schema.issues.teamId, teamId));
	const archived = and(...filters);
	// Measured before anything is read: an answer cut short would be a short export file that
	// says nothing of what it lacks, so too large is refused whole.
	if (archiveSize(db, archived) > ARCHIVE_WHOLE_BUDGET) return "too_large";
	return {
		issues: db
			.select()
			.from(schema.issues)
			.where(archived)
			.orderBy(asc(schema.issues.teamId), asc(schema.issues.number))
			.all()
			.map(toIssue),
		comments: db
			.select(getTableColumns(schema.comments))
			.from(schema.comments)
			.innerJoin(schema.issues, eq(schema.issues.id, schema.comments.issueId))
			.where(and(isNull(schema.comments.deletedAt), archived))
			.orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
			.all()
			.map(toComment),
		activities: db
			.select(getTableColumns(schema.activities))
			.from(schema.activities)
			.innerJoin(schema.issues, eq(schema.issues.id, schema.activities.issueId))
			.where(archived)
			// Insertion order, as in a snapshot.
			.orderBy(sql`${schema.activities}.rowid`)
			.all()
			.map(toActivity),
	};
}

/**
 * The most bytes `findArchivedIssues` answers at once, as `archiveSize` counts them: under the
 * Durable Object's 32 MiB RPC limit, with room for what the count leaves out.
 */
const ARCHIVE_WHOLE_BUDGET = 24 * 1024 * 1024;

/**
 * What each row of an answer comes to besides its text and JSON columns: its keys, punctuation,
 * numbers and flags, with every number at 16 digits and every flag `false`. Measured on real rows
 * in the sync tests, which fail when a column is added or dropped until these follow.
 */
export const ARCHIVE_ROW_ALLOWANCE = { issue: 375, comment: 96, activity: 121 } as const;

// The columns each kind of row sends, as `toIssue`, `toComment` and `toActivity` shape them.
const { fieldStamps: _, deletedAt: __, ...issueColumns } = getTableColumns(schema.issues);
const { deletedAt: ___, ...commentColumns } = getTableColumns(schema.comments);
const activityColumns = getTableColumns(schema.activities);

/**
 * About how many bytes the archived issues `where` selects come to, with their comments and
 * history: every text and JSON value measured, and each row's allowance for the rest. Counted in
 * SQL, so a large archive is never read to find out it is too large.
 */
function archiveSize(db: Db, where: SQL | undefined): number {
	const issues = db
		.select({ size: rowsSize(issueColumns, ARCHIVE_ROW_ALLOWANCE.issue) })
		.from(schema.issues)
		.where(where)
		.get();
	const comments = db
		.select({ size: rowsSize(commentColumns, ARCHIVE_ROW_ALLOWANCE.comment) })
		.from(schema.comments)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.comments.issueId))
		.where(and(isNull(schema.comments.deletedAt), where))
		.get();
	const activities = db
		.select({ size: rowsSize(activityColumns, ARCHIVE_ROW_ALLOWANCE.activity) })
		.from(schema.activities)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.activities.issueId))
		.where(where)
		.get();
	return (issues?.size ?? 0) + (comments?.size ?? 0) + (activities?.size ?? 0);
}

/** The bytes of the rows a query selects, from their text and JSON `columns` and an allowance. */
function rowsSize(columns: Record<string, Column>, allowance: number): SQL<number> {
	const values = Object.values(columns).flatMap((column) => {
		if (column.dataType === "string") return [valueSize(sql`json_quote(${column})`, column)];
		// Stored as the JSON it is sent as, or null.
		if (column.dataType === "json") return [sql`coalesce(${valueSize(column, column)}, 4)`];
		return [];
	});
	return sql<number>`coalesce(sum(${sql.join(values, sql` + `)} + ${sql.raw(String(allowance))}), 0)`;
}

/** A pattern for text with a character past U+00FF, written out so it binds no parameter. */
const WIDE = sql.raw(`'*[^' || char(1) || '-' || char(255) || ']*'`);

/**
 * The bytes of `value`, the JSON form of `text`: its length in UTF-8, or, when `text` has a
 * character past U+00FF, two bytes a character, as the structured clone that carries an RPC
 * answer stores such a string, whichever is more.
 */
function valueSize(value: SQL | Column, text: Column): SQL {
	return sql`max(length(cast(${value} as blob)), case when ${text} glob ${WIDE} then 2 * length(${text}) else 0 end)`;
}

/**
 * One page of the live archived issues whole, or of one team's, with their comments and history:
 * what a replica leaves out of them, for an export. By id, after `after`, so each issue is on one
 * page however many are archived or restored between pages. A page ends at `limit` issues, or
 * once it comes to `ARCHIVE_PAGE_BUDGET` characters of JSON, whichever is first, but always holds
 * one issue, so a reader always gets further. Reads only.
 */
export function findArchivedIssuesPage(
	db: Db,
	request: { teamId: string | null; after: string | null; limit: number },
): ArchivedIssuesPage {
	const filters: SQL[] = [isNull(schema.issues.deletedAt), isNotNull(schema.issues.archivedAt)];
	if (request.teamId !== null) filters.push(eq(schema.issues.teamId, request.teamId));
	if (request.after !== null) filters.push(gt(schema.issues.id, request.after));
	// One more than a page, to know whether another follows.
	const rows = db
		.select()
		.from(schema.issues)
		.where(and(...filters))
		.orderBy(asc(schema.issues.id))
		.limit(request.limit + 1)
		.all();

	const page: ArchivedIssuesPage = { issues: [], comments: [], activities: [], next: null };
	let size = 0;
	for (const [index, row] of rows.entries()) {
		if (index === request.limit || (index > 0 && size >= ARCHIVE_PAGE_BUDGET)) {
			page.next = page.issues.at(-1)?.id ?? null;
			break;
		}
		// One issue at a time, rather than its page's ids in one query: the object binds at most
		// 100 parameters a query, and this measures each issue as it goes.
		const issue = toIssue(row);
		const comments = db
			.select()
			.from(schema.comments)
			.where(and(eq(schema.comments.issueId, row.id), isNull(schema.comments.deletedAt)))
			.orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
			.all()
			.map(toComment);
		const activities = db
			.select()
			.from(schema.activities)
			.where(eq(schema.activities.issueId, row.id))
			// Insertion order, as in a snapshot.
			.orderBy(sql`${schema.activities}.rowid`)
			.all()
			.map(toActivity);
		size += JSON.stringify([issue, comments, activities]).length;
		page.issues.push(issue);
		page.comments.push(...comments);
		page.activities.push(...activities);
	}
	return page;
}

/** The rows that belong to an issue and that replicas leave out while it is archived. */
function rowsOf(db: Db, issueId: string) {
	return {
		comments: db
			.select()
			.from(schema.comments)
			.where(and(eq(schema.comments.issueId, issueId), isNull(schema.comments.deletedAt)))
			.orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
			.all(),
		activities: db
			.select()
			.from(schema.activities)
			.where(eq(schema.activities.issueId, issueId))
			// Insertion order, as in a snapshot.
			.orderBy(sql`${schema.activities}.rowid`)
			.all(),
		proposals: db
			.select()
			.from(schema.proposals)
			.where(and(eq(schema.proposals.issueId, issueId), eq(schema.proposals.status, "open")))
			.orderBy(asc(schema.proposals.createdAt), asc(schema.proposals.id))
			.all(),
		pullRequests: db
			.select()
			.from(schema.pullRequests)
			.where(
				sql`exists (select 1 from json_each(${schema.pullRequests.issueIds}) where value = ${issueId})`,
			)
			.orderBy(asc(schema.pullRequests.createdAt), asc(schema.pullRequests.id))
			.all(),
	};
}
