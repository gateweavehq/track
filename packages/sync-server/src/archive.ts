import {
	ARCHIVE_PAGE_BUDGET,
	type ArchivedIssuesPage,
	type IssueDetails,
} from "@gateweave/track-protocol";
import { and, asc, eq, gt, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
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
 * One page of the live archived issues whole, or of one team's, with their comments and history:
 * what a replica leaves out of them, for an export. By id, after `after`, so each issue is on one
 * page however many are archived or restored between pages. A page ends at `limit` issues, or
 * once it comes to `ARCHIVE_PAGE_BUDGET` characters of JSON, whichever is first, but always holds
 * one issue, so a reader always gets further. Reads only.
 */
export function findArchivedIssues(
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
