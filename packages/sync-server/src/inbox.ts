import { type InboxEvent, type MutationArgs, privateId } from "@gateweave/track-protocol";
import { and, eq, isNull, ne } from "drizzle-orm";
import * as schema from "./db/schema";
import type { ChangeSet } from "./log";
import { MutationRejected } from "./rejected";
import { type Db, toInboxItem, toSubscription } from "./state";

/**
 * Subscriptions and inboxes. People subscribed to an issue hear of what others do to it: the
 * creator, the assignee and whoever comments are subscribed on their own, and anyone can
 * subscribe or unsubscribe. Agents have neither; they hear through webhooks.
 *
 * Mutation handlers say what they did in the change set's events, for webhooks; {@link notify}
 * reads the same events once the handler is done, in the same transaction, so a rolled-back
 * write tells nobody and a retried mutation id tells nobody twice.
 */
export function notify(db: Db, changes: ChangeSet, actorId: string, imported: boolean): void {
	const inbox = new Inbox(db, changes, actorId);
	for (const event of changes.events) {
		switch (event.type) {
			case "issue.created": {
				const { issue } = event;
				// An imported issue tells nobody, and leaves out its importer, who only moved it
				// here. Its assignee is subscribed all the same.
				if (!imported) inbox.subscribe(issue.id, actorId);
				if (issue.assigneeId === null) break;
				inbox.subscribe(issue.id, issue.assigneeId, { force: true });
				if (!imported) inbox.tell(issue.id, issue.assigneeId, { type: "assigned" });
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
				if (issue.assigneeId !== previous.assigneeId) {
					if (previous.assigneeId !== null && inbox.subscribed(issue.id, previous.assigneeId)) {
						inbox.tell(issue.id, previous.assigneeId, { type: "unassigned" });
					}
					if (issue.assigneeId !== null) {
						inbox.subscribe(issue.id, issue.assigneeId, { force: true });
						inbox.tell(issue.id, issue.assigneeId, { type: "assigned" });
					}
				}
				break;
			}
			case "issue.deleted":
				inbox.forgetIssue(event.issue.id);
				break;
			case "comment.created":
				if (imported) break;
				inbox.subscribe(event.comment.issueId, actorId);
				inbox.tellSubscribers(event.comment.issueId, {
					type: "comment",
					commentId: event.comment.id,
				});
				break;
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
	inbox.flush();
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

	/** Puts an event in a person's inbox, unless they caused it. */
	tell(issueId: string, memberId: string, event: InboxEvent): void {
		if (memberId === this.actorId || !this.#isPerson(memberId)) return;
		const id = privateId(issueId, memberId);
		const existing =
			this.#items.get(id) ??
			this.db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id)).get();
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
		});
	}

	tellSubscribers(issueId: string, event: InboxEvent): void {
		const subscribers = this.db
			.select({ memberId: schema.subscriptions.memberId })
			.from(schema.subscriptions)
			.where(
				and(eq(schema.subscriptions.issueId, issueId), eq(schema.subscriptions.subscribed, true)),
			)
			.all();
		for (const { memberId } of subscribers) this.tell(issueId, memberId, event);
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

	flush(): void {
		for (const row of this.#items.values()) {
			this.db
				.insert(schema.inboxItems)
				.values(row)
				.onConflictDoUpdate({ target: schema.inboxItems.id, set: row })
				.run();
			this.changes.put("inbox", toInboxItem(row));
		}
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
