import {
	EMAIL_DELAY_MS,
	type InboxEvent,
	type MutationArgs,
	mentionedIds,
	type NotificationSettings,
	newMentions,
	privateId,
	SYSTEM_ACTOR_ID,
} from "@gateweave/track-protocol";
import { and, eq, isNull, ne } from "drizzle-orm";
import * as schema from "./db/schema";
import type { ChangeSet } from "./log";
import { readSettings } from "./notifications";
import { MutationRejected } from "./rejected";
import { type Db, toInboxItem, toSubscription } from "./state";

/**
 * Subscriptions and inboxes. People subscribed to an issue hear of what others do to it: the
 * creator, the assignee, whoever comments and whoever is mentioned are subscribed on their own,
 * and anyone can subscribe or unsubscribe. A mention tells the person mentioned even if they
 * unsubscribed. Agents have neither; they hear through webhooks. Each person's
 * notification settings say which kinds of news reach their inbox, and which are emailed when
 * they stay unread (`notifications.ts`).
 *
 * Mutation handlers say what they did in the change set's events, for webhooks; {@link notify}
 * reads the same events once the handler is done, in the same transaction, so a rolled-back
 * write tells nobody and a retried mutation id tells nobody twice. Returns whether it set an
 * email's time, which the alarm must then plan for.
 */
export function notify(db: Db, changes: ChangeSet, actorId: string, imported: boolean): boolean {
	const inbox = new Inbox(db, changes, actorId);
	for (const event of changes.events) {
		switch (event.type) {
			case "issue.created": {
				const { issue } = event;
				// An imported issue tells nobody, and leaves out its importer, who only moved it
				// here. Its assignee is subscribed all the same.
				if (!imported) inbox.subscribe(issue.id, actorId);
				const told = new Set<string>();
				if (issue.assigneeId !== null) {
					inbox.subscribe(issue.id, issue.assigneeId, { force: true });
					if (!imported && inbox.tell(issue.id, issue.assigneeId, { type: "assigned" })) {
						told.add(issue.assigneeId);
					}
				}
				if (!imported) inbox.mention(issue.id, mentionedIds(issue.description), null, told);
				break;
			}
			case "issue.updated": {
				const { issue, previous } = event;
				if (issue.status !== previous.status) {
					inbox.tellSubscribers(issue.id, {
						type: "status",
						from: previous.status,
						to: issue.status,
					});
				}
				// After the status, so that the new assignee's item shows that they were assigned.
				const told = new Set<string>();
				if (issue.assigneeId !== previous.assigneeId) {
					if (previous.assigneeId !== null && inbox.subscribed(issue.id, previous.assigneeId)) {
						inbox.tell(issue.id, previous.assigneeId, { type: "unassigned" });
					}
					if (issue.assigneeId !== null) {
						inbox.subscribe(issue.id, issue.assigneeId, { force: true });
						if (inbox.tell(issue.id, issue.assigneeId, { type: "assigned" })) {
							told.add(issue.assigneeId);
						}
					}
				}
				if (issue.description !== previous.description) {
					const mentioned = newMentions(previous.description, issue.description);
					inbox.mention(issue.id, mentioned, null, told);
				}
				break;
			}
			case "issue.deleted":
				inbox.forgetIssue(event.issue.id);
				break;
			case "comment.created": {
				if (imported) break;
				const { comment } = event;
				inbox.subscribe(comment.issueId, actorId);
				// Those the comment mentions hear of it as a mention, not twice.
				const told = inbox.mention(comment.issueId, mentionedIds(comment.body), comment.id);
				inbox.tellSubscribers(comment.issueId, { type: "comment", commentId: comment.id }, told);
				break;
			}
			case "comment.updated": {
				const { comment, previous } = event;
				inbox.mention(comment.issueId, newMentions(previous.body, comment.body), comment.id);
				break;
			}
			case "proposal.created":
			case "proposal.updated":
				inbox.tellSubscribers(event.proposal.issueId, {
					type: "proposal",
					proposalId: event.proposal.id,
					change: event.proposal.change,
				});
				break;
		}
	}
	return inbox.flush();
}

/**
 * Reminds assignees that their issues are due, from the alarm; Track is the actor. Returns whether
 * a reminder is to be emailed.
 */
export function remindAssignees(
	db: Db,
	changes: ChangeSet,
	reminders: { issueId: string; memberId: string; dueOn: string }[],
): boolean {
	const inbox = new Inbox(db, changes, SYSTEM_ACTOR_ID);
	for (const { issueId, memberId, dueOn } of reminders) {
		inbox.tell(issueId, memberId, { type: "due", on: dueOn });
	}
	return inbox.flush();
}

/** `issue.subscribe`: a person's own subscription to an issue. */
export function subscribeToIssue(
	db: Db,
	changes: ChangeSet,
	member: schema.MemberRow,
	args: MutationArgs<"issue.subscribe">,
): void {
	requirePerson(member);
	const issue = db.select().from(schema.issues).where(eq(schema.issues.id, args.issueId)).get();
	if (!issue || issue.deletedAt !== null)
		throw new MutationRejected("not_found", "Issue not found");
	const existing = findSubscription(db, args.issueId, member.userId);
	if (existing?.subscribed === args.subscribed) return;
	writeSubscription(db, changes, args.issueId, member.userId, args.subscribed);
}

/**
 * `inbox.update`: a person reading, archiving or snoozing their own inbox items. Items that are
 * gone, with their issue, are skipped like ones that need no change, so that marking a whole
 * inbox read never fails over one of them.
 */
export function updateInbox(
	db: Db,
	changes: ChangeSet,
	member: schema.MemberRow,
	args: MutationArgs<"inbox.update">,
): void {
	requirePerson(member);
	const { patch } = args;
	for (const { issueId, seen } of args.items) {
		const item = db
			.select()
			.from(schema.inboxItems)
			.where(eq(schema.inboxItems.id, privateId(issueId, member.userId)))
			.get();
		if (!item) continue;
		// Dismissing an item never takes an event the person has not seen with it.
		const current = item.updatedAt <= seen;
		const next = { ...item };
		if (patch.read === true && current) next.unread = 0;
		if (patch.read === false) next.unread = Math.max(1, item.unread);
		// Archiving is being done with it, which reads it too.
		if (patch.archived === true && current) {
			next.archivedAt = item.archivedAt ?? changes.now;
			next.unread = 0;
		}
		if (patch.archived === false) next.archivedAt = null;
		if (patch.snoozedUntil !== undefined && (patch.snoozedUntil === null || current)) {
			next.snoozedUntil = patch.snoozedUntil;
		}
		// An item read, archived or snoozed is dealt with, so its news is not emailed.
		if (next.unread === 0 || next.archivedAt !== null || next.snoozedUntil !== null) {
			next.emailAt = null;
		}
		if (
			next.unread === item.unread &&
			next.archivedAt === item.archivedAt &&
			next.snoozedUntil === item.snoozedUntil
		) {
			continue;
		}
		const row = db
			.update(schema.inboxItems)
			.set(next)
			.where(eq(schema.inboxItems.id, item.id))
			.returning()
			.get();
		if (row) changes.put("inbox", toInboxItem(row));
	}
}

/** Removes a member's subscriptions and inbox, when they leave the workspace. */
export function forgetMember(db: Db, changes: ChangeSet, memberId: string): void {
	const subscriptions = db
		.delete(schema.subscriptions)
		.where(eq(schema.subscriptions.memberId, memberId))
		.returning({ id: schema.subscriptions.id })
		.all();
	for (const { id } of subscriptions) changes.deletePrivate("subscription", id, memberId);
	const items = db
		.delete(schema.inboxItems)
		.where(eq(schema.inboxItems.memberId, memberId))
		.returning({ id: schema.inboxItems.id })
		.all();
	for (const { id } of items) changes.deletePrivate("inbox", id, memberId);
}

function requirePerson(member: schema.MemberRow) {
	if (member.role === "agent") throw new MutationRejected("forbidden", "Agents have no inbox");
}

function findSubscription(db: Db, issueId: string, memberId: string) {
	return db
		.select()
		.from(schema.subscriptions)
		.where(eq(schema.subscriptions.id, privateId(issueId, memberId)))
		.get();
}

function writeSubscription(
	db: Db,
	changes: ChangeSet,
	issueId: string,
	memberId: string,
	subscribed: boolean,
): void {
	const row: schema.SubscriptionRow = {
		id: privateId(issueId, memberId),
		issueId,
		memberId,
		subscribed,
		updatedAt: changes.now,
	};
	db.insert(schema.subscriptions)
		.values(row)
		.onConflictDoUpdate({ target: schema.subscriptions.id, set: row })
		.run();
	changes.put("subscription", toSubscription(row));
}

/** One write's effect on subscriptions and inboxes. */
class Inbox {
	/** People who are active members, by id. Loaded when first needed. */
	#people: Set<string> | undefined;
	/** Inbox items to write, by id: a write that tells someone twice writes their item once. */
	readonly #items = new Map<string, schema.InboxItemRow>();
	/** People's notification settings, by id. Loaded when first needed. */
	readonly #settings = new Map<string, NotificationSettings>();

	constructor(
		private readonly db: Db,
		private readonly changes: ChangeSet,
		private readonly actorId: string,
	) {}

	/**
	 * Subscribes a person to an issue, unless they unsubscribed from it before. `force` subscribes
	 * them all the same, as being assigned does.
	 */
	subscribe(issueId: string, memberId: string, { force = false } = {}): void {
		if (!this.#isPerson(memberId)) return;
		const existing = findSubscription(this.db, issueId, memberId);
		if (existing?.subscribed || (existing && !force)) return;
		writeSubscription(this.db, this.changes, issueId, memberId, true);
	}

	subscribed(issueId: string, memberId: string): boolean {
		return findSubscription(this.db, issueId, memberId)?.subscribed === true;
	}

	/**
	 * Puts an event in a person's inbox, unless they caused it or turned its kind off. If they want
	 * it by email, the item is emailed after a while unless they read it first. Returns whether
	 * they were told.
	 */
	tell(issueId: string, memberId: string, event: InboxEvent): boolean {
		if (memberId === this.actorId || !this.#isPerson(memberId)) return false;
		const level = this.#settingsOf(memberId)[event.type];
		if (level === "off") return false;
		const id = privateId(issueId, memberId);
		const existing =
			this.#items.get(id) ??
			this.db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id)).get();
		// Earlier news that is waiting keeps its time, so a busy issue is still emailed.
		const waiting = existing?.emailAt ?? null;
		this.#items.set(id, {
			id,
			issueId,
			memberId,
			event,
			actorId: this.actorId,
			unread: (existing?.unread ?? 0) + 1,
			updatedAt: this.changes.now,
			// News brings an item back from wherever it was put away.
			snoozedUntil: null,
			archivedAt: null,
			emailAt: level === "email" ? (waiting ?? this.changes.now + EMAIL_DELAY_MS) : waiting,
		});
		return true;
	}

	/** Tells everyone subscribed to an issue, except those already told of the same thing. */
	tellSubscribers(issueId: string, event: InboxEvent, except?: ReadonlySet<string>): void {
		const subscribers = this.db
			.select({ memberId: schema.subscriptions.memberId })
			.from(schema.subscriptions)
			.where(
				and(eq(schema.subscriptions.issueId, issueId), eq(schema.subscriptions.subscribed, true)),
			)
			.all();
		for (const { memberId } of subscribers) {
			if (!except?.has(memberId)) this.tell(issueId, memberId, event);
		}
	}

	/**
	 * Subscribes the people a description or comment mentions and tells them, except those in
	 * `told`, who heard of the same write already. Returns who was told. A mention does nothing
	 * for someone who turned mentions off: if they follow the issue, they hear of a comment as any
	 * subscriber does.
	 */
	mention(
		issueId: string,
		memberIds: string[],
		commentId: string | null,
		told: ReadonlySet<string> = new Set(),
	): Set<string> {
		const mentioned = new Set<string>();
		for (const memberId of memberIds) {
			if (memberId === this.actorId || told.has(memberId) || !this.#isPerson(memberId)) continue;
			if (this.#settingsOf(memberId).mention === "off") continue;
			this.subscribe(issueId, memberId);
			if (this.tell(issueId, memberId, { type: "mention", commentId })) mentioned.add(memberId);
		}
		return mentioned;
	}

	/** Removes everyone's subscriptions to a deleted issue, and the issue from their inboxes. */
	forgetIssue(issueId: string): void {
		const subscriptions = this.db
			.delete(schema.subscriptions)
			.where(eq(schema.subscriptions.issueId, issueId))
			.returning()
			.all();
		for (const { id, memberId } of subscriptions) {
			this.changes.deletePrivate("subscription", id, memberId);
		}
		const items = this.db
			.delete(schema.inboxItems)
			.where(eq(schema.inboxItems.issueId, issueId))
			.returning()
			.all();
		for (const { id, memberId } of items) {
			this.#items.delete(id);
			this.changes.deletePrivate("inbox", id, memberId);
		}
	}

	/** Writes the items. Returns whether any of them is to be emailed. */
	flush(): boolean {
		let email = false;
		for (const row of this.#items.values()) {
			this.db
				.insert(schema.inboxItems)
				.values(row)
				.onConflictDoUpdate({ target: schema.inboxItems.id, set: row })
				.run();
			this.changes.put("inbox", toInboxItem(row));
			if (row.emailAt !== null) email = true;
		}
		return email;
	}

	#settingsOf(memberId: string): NotificationSettings {
		let settings = this.#settings.get(memberId);
		if (!settings) {
			settings = readSettings(this.db, memberId);
			this.#settings.set(memberId, settings);
		}
		return settings;
	}

	#isPerson(memberId: string): boolean {
		this.#people ??= new Set(
			this.db
				.select({ userId: schema.members.userId })
				.from(schema.members)
				.where(and(isNull(schema.members.removedAt), ne(schema.members.role, "agent")))
				.all()
				.map((member) => member.userId),
		);
		return this.#people.has(memberId);
	}
}
