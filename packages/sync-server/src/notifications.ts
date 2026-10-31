import {
	DEFAULT_NOTIFICATIONS,
	EMAIL_INTERVAL_MS,
	GITHUB_ACTOR_ID,
	type InboxEvent,
	NOTIFICATION_KINDS,
	type NotificationSettings,
	type NotificationSettingsPatch,
} from "@gateweave/track-protocol";
import { and, asc, eq, isNotNull, lte, min } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Db } from "./state";
import { readLink, type WorkspaceLink } from "./webhooks";

/**
 * Members' notification settings, and the emails of inbox news they leave unread. News a member
 * wants by email marks its inbox item with when to send it (see `inbox.ts`); reading, archiving or
 * snoozing the item unmarks it. The alarm takes the marked items that are due, a member at a time,
 * and hands each member's to the object's `sendInboxDigest`, which the app implements. Items are
 * unmarked as they are taken, so a digest goes out at most once.
 */

/** Unread news on one issue, as an email tells it. */
export interface DigestItem {
	issue: { key: string; title: string };
	/** The newest event, as the inbox shows it. */
	event: InboxEvent;
	/** Who caused it, by name: a member, GitHub, or "Someone" for a member who has left. */
	actor: string;
	unread: number;
	updatedAt: number;
	/** The comment's text, for a comment that is still there. */
	comment: string | null;
}

/** One member's news from one workspace, newest first, to email them. */
export interface InboxDigest {
	workspace: WorkspaceLink;
	member: { id: string; name: string; email: string };
	items: DigestItem[];
}

/** A member's settings, with the defaults for the kinds they never changed. */
export function readSettings(db: Db, memberId: string): NotificationSettings {
	const row = findSettings(db, memberId);
	return { ...DEFAULT_NOTIFICATIONS, ...row?.levels };
}

/**
 * Changes a member's settings. When no kind of news reaches email any more, email that is waiting
 * is dropped too.
 */
export function updateSettings(
	db: Db,
	memberId: string,
	patch: NotificationSettingsPatch,
	now: number,
): NotificationSettings {
	const row = findSettings(db, memberId);
	const levels = { ...row?.levels, ...patch };
	db.insert(schema.notificationSettings)
		.values({ memberId, levels, emailedAt: row?.emailedAt ?? null, updatedAt: now })
		.onConflictDoUpdate({
			target: schema.notificationSettings.memberId,
			set: { levels, updatedAt: now },
		})
		.run();
	const settings = { ...DEFAULT_NOTIFICATIONS, ...levels };
	if (!NOTIFICATION_KINDS.some((kind) => settings[kind] === "email")) {
		db.update(schema.inboxItems)
			.set({ emailAt: null })
			.where(and(eq(schema.inboxItems.memberId, memberId), isNotNull(schema.inboxItems.emailAt)))
			.run();
	}
	return settings;
}

/** Turns email off for a member: what went to email goes to the inbox alone. */
export function unsubscribe(db: Db, memberId: string, now: number): void {
	const settings = readSettings(db, memberId);
	const patch: NotificationSettingsPatch = {};
	for (const kind of NOTIFICATION_KINDS) if (settings[kind] === "email") patch[kind] = "inbox";
	updateSettings(db, memberId, patch, now);
}

/** When the alarm should next look for digests to send, if any email is waiting. */
export function nextDigestAt(db: Db): number | null {
	const waiting = db
		.select({ memberId: schema.inboxItems.memberId, at: min(schema.inboxItems.emailAt) })
		.from(schema.inboxItems)
		.where(isNotNull(schema.inboxItems.emailAt))
		.groupBy(schema.inboxItems.memberId)
		.all();
	let next: number | null = null;
	for (const { memberId, at } of waiting) {
		if (at === null) continue;
		const due = Math.max(at, notBefore(db, memberId));
		next = next === null ? due : Math.min(next, due);
	}
	return next;
}

/**
 * Takes the digests that are due: each member's marked items whose time has come, unless the
 * member was emailed from this workspace within {@link EMAIL_INTERVAL_MS}. Their items wait.
 * Without a link to the workspace, which the sync gateway records, the email could link nowhere,
 * so due items are dropped instead.
 */
export function takeDueDigests(db: Db, now: number): InboxDigest[] {
	const due = db
		.select()
		.from(schema.inboxItems)
		.where(lte(schema.inboxItems.emailAt, now))
		.orderBy(asc(schema.inboxItems.memberId))
		.all();
	if (due.length === 0) return [];
	const workspace = readLink(db);
	const byMember = new Map<string, schema.InboxItemRow[]>();
	for (const item of due) {
		if (workspace && notBefore(db, item.memberId) > now) continue;
		byMember.set(item.memberId, [...(byMember.get(item.memberId) ?? []), item]);
	}

	const digests: InboxDigest[] = [];
	for (const [memberId, items] of byMember) {
		db.update(schema.inboxItems)
			.set({ emailAt: null })
			.where(and(eq(schema.inboxItems.memberId, memberId), lte(schema.inboxItems.emailAt, now)))
			.run();
		const member = db
			.select()
			.from(schema.members)
			.where(eq(schema.members.userId, memberId))
			.get();
		if (!workspace || !member || member.removedAt !== null || member.role === "agent") continue;
		db.insert(schema.notificationSettings)
			.values({ memberId, levels: {}, emailedAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: schema.notificationSettings.memberId,
				set: { emailedAt: now },
			})
			.run();
		digests.push({
			workspace,
			member: { id: member.userId, name: member.name, email: member.email },
			items: items
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.flatMap((item) => describe(db, item) ?? []),
		});
	}
	return digests.filter((digest) => digest.items.length > 0);
}

function describe(db: Db, item: schema.InboxItemRow): DigestItem | undefined {
	const issue = db
		.select({
			title: schema.issues.title,
			number: schema.issues.number,
			team: schema.teams.key,
			deletedAt: schema.issues.deletedAt,
		})
		.from(schema.issues)
		.innerJoin(schema.teams, eq(schema.teams.id, schema.issues.teamId))
		.where(eq(schema.issues.id, item.issueId))
		.get();
	if (!issue || issue.deletedAt !== null) return undefined;
	let comment: string | null = null;
	if (item.event.type === "comment") {
		const row = db
			.select({ body: schema.comments.body, deletedAt: schema.comments.deletedAt })
			.from(schema.comments)
			.where(eq(schema.comments.id, item.event.commentId))
			.get();
		comment = row && row.deletedAt === null ? row.body : null;
	}
	return {
		issue: { key: `${issue.team}-${issue.number}`, title: issue.title },
		event: item.event,
		actor: actorName(db, item.actorId),
		unread: item.unread,
		updatedAt: item.updatedAt,
		comment,
	};
}

function actorName(db: Db, actorId: string): string {
	if (actorId === GITHUB_ACTOR_ID) return "GitHub";
	const member = db
		.select({ name: schema.members.name })
		.from(schema.members)
		.where(eq(schema.members.userId, actorId))
		.get();
	return member?.name ?? "Someone";
}

/** The earliest a member may be emailed again from this workspace. */
function notBefore(db: Db, memberId: string): number {
	const emailedAt = findSettings(db, memberId)?.emailedAt;
	return emailedAt === null || emailedAt === undefined ? 0 : emailedAt + EMAIL_INTERVAL_MS;
}

function findSettings(db: Db, memberId: string) {
	return db
		.select()
		.from(schema.notificationSettings)
		.where(eq(schema.notificationSettings.memberId, memberId))
		.get();
}
