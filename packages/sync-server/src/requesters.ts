import { eq, isNotNull } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Db } from "./state";

/** A decision on a request, for the person who filed it through a form or by email. */
export interface RequesterNotice {
	workspaceId: string;
	email: string;
	accepted: boolean;
	/** What the person who declined it wrote back, as Markdown. */
	reply: string | null;
	request: { title: string };
	team: string;
}

/** Notes who filed a request, to tell them of the decision on it. */
export function recordRequester(
	db: Db,
	issueId: string,
	requester: { workspaceId: string; email: string },
	now: number,
): void {
	db.insert(schema.requesters)
		.values({ issueId, ...requester, createdAt: now })
		.run();
}

/**
 * Marks the decision on a request to be emailed to whoever filed it, if they left an address.
 * Returns whether there is someone to tell, so the write wakes the alarm.
 */
export function noteDecision(
	db: Db,
	issueId: string,
	accepted: boolean,
	reply: string | null,
): boolean {
	const row = db
		.update(schema.requesters)
		.set({ notice: accepted ? "accepted" : "declined", reply: accepted ? null : reply })
		.where(eq(schema.requesters.issueId, issueId))
		.returning()
		.get();
	return row !== undefined;
}

/** Forgets who filed a deleted request, so nobody is told of it. */
export function forgetRequester(db: Db, issueId: string): void {
	db.delete(schema.requesters).where(eq(schema.requesters.issueId, issueId)).run();
}

/** Whether a decision waits to be emailed. */
export function hasRequesterNotices(db: Db): boolean {
	return (
		db
			.select({ issueId: schema.requesters.issueId })
			.from(schema.requesters)
			.where(isNotNull(schema.requesters.notice))
			.get() !== undefined
	);
}

/**
 * Takes the decisions waiting to be emailed, and forgets their requesters: each is told once.
 * The email goes after the transaction, so a failure loses it rather than sending it twice, as
 * inbox digests do.
 */
export function takeRequesterNotices(db: Db): RequesterNotice[] {
	const rows = db
		.select({
			requester: schema.requesters,
			title: schema.issues.title,
			team: schema.teams.name,
		})
		.from(schema.requesters)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.requesters.issueId))
		.innerJoin(schema.teams, eq(schema.teams.id, schema.issues.teamId))
		.where(isNotNull(schema.requesters.notice))
		.all();
	const notices: RequesterNotice[] = [];
	for (const { requester, title, team } of rows) {
		db.delete(schema.requesters).where(eq(schema.requesters.issueId, requester.issueId)).run();
		notices.push({
			workspaceId: requester.workspaceId,
			email: requester.email,
			accepted: requester.notice === "accepted",
			reply: requester.reply,
			request: { title },
			team,
		});
	}
	return notices;
}
