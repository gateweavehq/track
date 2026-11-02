import {
	ARCHIVE_PAGE_BUDGET,
	type ArchivedIssues,
	type ArchivedIssuesPage,
	type IssueDetails,
} from "@gateweave/track-protocol";
import { and, asc, eq, getTableColumns, gt, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
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
 * The most characters of text `findArchivedIssues` answers at once. Up to three bytes each in
 * UTF-8, it keeps the answer under the Durable Object's 32 MiB RPC limit, with room to spare.
 */
const ARCHIVE_WHOLE_BUDGET = 8 * 1024 * 1024;

/**
 * About how many characters of JSON the archived issues `where` selects come to, with their
 * comments and history, from the long text columns and a generous allowance for the rest of each
 * row. Counted in SQL, so a large archive is never read to find out it is too large.
 */
function archiveSize(db: Db, where: SQL | undefined): number {
	const issues = db
		.select({
			size: sql<number>`coalesce(sum(length(${schema.issues.title}) + coalesce(length(${schema.issues.description}), 0) + 1024), 0)`,
		})
		.from(schema.issues)
		.where(where)
		.get();
	const comments = db
		.select({ size: sql<number>`coalesce(sum(length(${schema.comments.body}) + 512), 0)` })
		.from(schema.comments)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.comments.issueId))
		.where(and(isNull(schema.comments.deletedAt), where))
		.get();
	const activities = db
		.select({ size: sql<number>`coalesce(sum(length(${schema.activities.change}) + 512), 0)` })
		.from(schema.activities)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.activities.issueId))
		.where(where)
		.get();
	return (issues?.size ?? 0) + (comments?.size ?? 0) + (activities?.size ?? 0);
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
