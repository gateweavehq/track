import { and, asc, eq, isNull, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import { type ChangeSet, onlyArchived } from "./log";
import { type Db, toActivity, toComment, toProposal, toPullRequest } from "./state";

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
	const issueId = row.id;

	const comments = db
		.select()
		.from(schema.comments)
		.where(and(eq(schema.comments.issueId, issueId), isNull(schema.comments.deletedAt)))
		.orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
		.all();
	const activities = db
		.select()
		.from(schema.activities)
		.where(eq(schema.activities.issueId, issueId))
		// Insertion order, as in a snapshot.
		.orderBy(sql`${schema.activities}.rowid`)
		.all();
	const proposals = db
		.select()
		.from(schema.proposals)
		.where(and(eq(schema.proposals.issueId, issueId), eq(schema.proposals.status, "open")))
		.orderBy(asc(schema.proposals.createdAt), asc(schema.proposals.id))
		.all();
	const pullRequests = db
		.select()
		.from(schema.pullRequests)
		.where(
			sql`exists (select 1 from json_each(${schema.pullRequests.issueIds}) where value = ${issueId})`,
		)
		.orderBy(asc(schema.pullRequests.createdAt), asc(schema.pullRequests.id))
		.all();

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
