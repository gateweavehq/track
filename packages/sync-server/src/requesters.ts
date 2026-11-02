import { INTAKE_EMAIL_ACTOR_ID, type WebhookActor } from "@gateweave/track-protocol";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./db/schema";
import { notifyOfReply } from "./inbox";
import { ChangeSet, type WriteResult } from "./log";
import { indexIssue } from "./search";
import { type Db, toComment } from "./state";
import { queueDeliveries } from "./webhooks";

const EMAIL_ACTOR: WebhookActor = { id: INTAKE_EMAIL_ACTOR_ID, name: "Email", type: "system" };

/** A reply key: longer than a team's intake key, so one address never reads as the other. */
const REPLY_KEY = /^[a-z2-7]{26}$/;

/** A decision on a request, for the person who filed it through a form or by email. */
export interface RequesterNotice {
	workspaceId: string;
	email: string;
	accepted: boolean;
	/** What the person who declined it wrote back, as Markdown. */
	reply: string | null;
	request: { title: string };
	team: string;
	/** The secret of the address where the requester's reply to this email becomes a comment. */
	replyKey: string;
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
 * Takes the decisions waiting to be emailed: each is told once. The email goes after the
 * transaction, so a failure loses it rather than sending it twice, as inbox digests do. The
 * requester stays, with the key of the address their reply goes to, until the request is deleted.
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
		const replyKey = requester.replyKey ?? newReplyKey();
		db.update(schema.requesters)
			.set({ notice: null, reply: null, replyKey })
			.where(eq(schema.requesters.issueId, requester.issueId))
			.run();
		notices.push({
			workspaceId: requester.workspaceId,
			email: requester.email,
			accepted: requester.notice === "accepted",
			reply: requester.reply,
			request: { title },
			team,
			replyKey,
		});
	}
	return notices;
}

/** A reply to a decision, as the email gateway passes it on, once its address checks out. */
export const requesterReply = z.object({
	key: z.string().max(64),
	/** Who sent it, which must be whom the decision went to. */
	from: z.email().max(254),
	/** The reply's own text, quotes taken out, as Markdown. */
	body: z.string().trim().min(1).max(100_000),
});
export type RequesterReply = z.infer<typeof requesterReply>;

/** Who may reply where: a reply key and the address the reply came from. */
export interface ReplyAddress {
	key: string;
	from: string;
}

/**
 * The request a reply to `key` would be filed on, with the address its decision went to, the only
 * one whose replies it takes. Null for a key no request has, or a deleted request. Reads only.
 */
export function findReplyRequest(db: Db, key: string): { id: string; email: string } | null {
	if (!REPLY_KEY.test(key)) return null;
	const requester = db
		.select()
		.from(schema.requesters)
		.where(eq(schema.requesters.replyKey, key))
		.get();
	if (!requester) return null;
	const issue = db
		.select({ id: schema.issues.id })
		.from(schema.issues)
		.where(and(eq(schema.issues.id, requester.issueId), isNull(schema.issues.deletedAt)))
		.get();
	return issue ? { id: issue.id, email: requester.email } : null;
}

/**
 * The request a reply to `key` from `from` would be filed on, or null for a key no request has,
 * another sender, or a deleted request. Reads only.
 */
export function findReplyTarget(db: Db, { key, from }: ReplyAddress): { id: string } | null {
	const request = findReplyRequest(db, key);
	if (!request || request.email !== from.trim().toLowerCase()) return null;
	return { id: request.id };
}

/**
 * Files a requester's reply to a decision as a comment on their request, by Email, as the
 * request itself was. The key admits it, and only from the address the decision went to. It
 * mentions nobody, as a stranger's text never does, but the people who follow the request hear of
 * it. Null for a key no request has, another sender, or a deleted request. Runs in one
 * transaction.
 */
export function fileReply(
	db: Db,
	reply: RequesterReply,
	now: number,
): (WriteResult & { commentId: string }) | null {
	const issue = findReplyTarget(db, reply);
	if (!issue) return null;

	const changes = new ChangeSet(db, EMAIL_ACTOR.id, now);
	const row: schema.CommentRow = {
		id: crypto.randomUUID(),
		issueId: issue.id,
		authorId: EMAIL_ACTOR.id,
		body: reply.body,
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
	};
	db.insert(schema.comments).values(row).run();
	indexIssue(db, issue.id);
	changes.put("comment", toComment(row));
	changes.events.push({ type: "comment.created", comment: row });
	const wake = notifyOfReply(db, changes, issue.id, row.id);
	const result = changes.result();
	const queued = queueDeliveries(db, EMAIL_ACTOR, changes.events, result.version, now);
	return { ...result, queued, wake, commentId: row.id };
}

function newReplyKey(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	const bytes = crypto.getRandomValues(new Uint8Array(26));
	return Array.from(bytes, (byte) => alphabet[byte % 32]).join("");
}
