import { MENTION_SCHEME, type ProposedChange, renameMentions } from "@gateweave/track-protocol";
import { and, eq, isNull, lt, type SQLWrapper, sql } from "drizzle-orm";
import { forgetInAudit } from "./audit";
import * as schema from "./db/schema";
import { forgetMember } from "./inbox";
import { ChangeSet, currentVersion, type WriteResult } from "./log";
import { indexComment, indexIssue, optimizeSearch } from "./search";
import {
	type Db,
	isForgotten,
	toComment,
	toInboxItem,
	toIssue,
	toMember,
	toProject,
	toProjectUpdate,
	toProposal,
	toTemplate,
} from "./state";

/** What a workspace calls someone who deleted their account. */
export const FORGOTTEN_NAME = "Deleted member";

interface Person {
	id: string;
	name: string;
}

/**
 * Takes out of the workspace what it holds about someone who deleted their account: their name,
 * address and picture, what was private to them, and their name where a mention or a copy of it
 * reached a row, the log or a webhook. Their row stays so that what they did still resolves, and
 * so does what they wrote, which is the team's record. Doing it again changes nothing, and no ops
 * come of it, because a gateway repeats it until it hears that it worked.
 */
export function forgetPerson(db: Db, userId: string, now: number): WriteResult {
	const changes = new ChangeSet(db, null, now);
	const member = db.select().from(schema.members).where(eq(schema.members.userId, userId)).get();
	if (!member) return changes.result();
	const person: Person = { id: userId, name: FORGOTTEN_NAME };

	forgetMember(db, changes, userId);
	db.delete(schema.notificationSettings)
		.where(eq(schema.notificationSettings.memberId, userId))
		.run();
	renameInRows(db, changes, person);
	// An invitation is kept by the address it went to, which named them too.
	forgetInAudit(db, member.email);

	// Last, so that the newest op is everyone's and the log below can drop every op of theirs.
	const forgotten: schema.MemberRow = {
		...member,
		name: person.name,
		email: "",
		image: null,
		proposes: [],
		removedAt: member.removedAt ?? now,
	};
	if (!isForgotten(member)) {
		db.update(schema.members).set(forgotten).where(eq(schema.members.userId, userId)).run();
		changes.put("member", toMember(forgotten));
	}

	scrubLog(db, person, forgotten);
	scrubDeliveries(db, person);
	return changes.result();
}

/**
 * Where the Markdown someone wrote can name them. The rows keep their dates: nobody edited them.
 * A renamed link still matches, so a row that is already right is skipped here, which keeps doing
 * this again from writing anything.
 */
function renameInRows(db: Db, changes: ChangeSet, person: Person): void {
	const mentioned = (column: SQLWrapper) =>
		sql`instr(${column}, ${`${MENTION_SCHEME}${person.id})`}) > 0`;
	let searchChanged = false;

	const issues = db.select().from(schema.issues).where(mentioned(schema.issues.description)).all();
	for (const issue of issues) {
		const description = renameMentions(issue.description ?? "", person);
		if (description === issue.description) continue;
		if (issue.deletedAt !== null) {
			db.update(schema.issues).set({ description }).where(eq(schema.issues.id, issue.id)).run();
			continue;
		}
		const version = changes.nextVersion;
		db.update(schema.issues)
			.set({ description, version })
			.where(eq(schema.issues.id, issue.id))
			.run();
		changes.put("issue", toIssue({ ...issue, description, version }));
		indexIssue(db, issue.id);
		searchChanged = true;
	}

	const comments = db
		.select({ comment: schema.comments, issueDeletedAt: schema.issues.deletedAt })
		.from(schema.comments)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.comments.issueId))
		.where(mentioned(schema.comments.body))
		.all();
	for (const { comment, issueDeletedAt } of comments) {
		const body = renameMentions(comment.body, person);
		if (body === comment.body) continue;
		db.update(schema.comments).set({ body }).where(eq(schema.comments.id, comment.id)).run();
		// Deleting an issue leaves its comments' rows as they were, and replicas dropped them then.
		if (comment.deletedAt !== null || issueDeletedAt !== null) continue;
		changes.put("comment", toComment({ ...comment, body }));
		indexComment(db, comment);
		searchChanged = true;
	}
	if (searchChanged) optimizeSearch(db);

	const projects = db
		.select()
		.from(schema.projects)
		.where(mentioned(schema.projects.description))
		.all();
	for (const project of projects) {
		const description = renameMentions(project.description ?? "", person);
		if (description === project.description) continue;
		db.update(schema.projects).set({ description }).where(eq(schema.projects.id, project.id)).run();
		if (project.deletedAt === null) changes.put("project", toProject({ ...project, description }));
	}

	const updates = db
		.select()
		.from(schema.projectUpdates)
		.where(mentioned(schema.projectUpdates.body))
		.all();
	for (const update of updates) {
		const body = renameMentions(update.body, person);
		if (body === update.body) continue;
		db.update(schema.projectUpdates)
			.set({ body })
			.where(eq(schema.projectUpdates.id, update.id))
			.run();
		if (update.deletedAt === null)
			changes.put("projectUpdate", toProjectUpdate({ ...update, body }));
	}

	const templates = db
		.select()
		.from(schema.templates)
		.where(mentioned(schema.templates.description))
		.all();
	for (const template of templates) {
		const description = renameMentions(template.description ?? "", person);
		if (description === template.description) continue;
		db.update(schema.templates)
			.set({ description })
			.where(eq(schema.templates.id, template.id))
			.run();
		changes.put("template", toTemplate({ ...template, description }));
	}

	const proposals = db
		.select({ proposal: schema.proposals, issueDeletedAt: schema.issues.deletedAt })
		.from(schema.proposals)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.proposals.issueId))
		.where(mentioned(schema.proposals.change))
		.all();
	for (const { proposal, issueDeletedAt } of proposals) {
		const change = rewritten(proposal.change, person) as ProposedChange;
		if (JSON.stringify(change) === JSON.stringify(proposal.change)) continue;
		db.update(schema.proposals).set({ change }).where(eq(schema.proposals.id, proposal.id)).run();
		// Replicas hold only the open ones.
		if (proposal.status === "open" && issueDeletedAt === null) {
			changes.put("proposal", toProposal({ ...proposal, change }));
		}
	}

	// News of a proposal carries a copy of it, in someone else's inbox.
	const items = db.select().from(schema.inboxItems).where(mentioned(schema.inboxItems.event)).all();
	for (const item of items) {
		const event = rewritten(item.event, person) as schema.InboxItemRow["event"];
		if (JSON.stringify(event) === JSON.stringify(item.event)) continue;
		db.update(schema.inboxItems).set({ event }).where(eq(schema.inboxItems.id, item.id)).run();
		changes.put("inbox", toInboxItem({ ...item, event }));
	}

	const requesters = db
		.select()
		.from(schema.requesters)
		.where(mentioned(schema.requesters.reply))
		.all();
	for (const { issueId, reply } of requesters) {
		db.update(schema.requesters)
			.set({ reply: renameMentions(reply ?? "", person) })
			.where(eq(schema.requesters.issueId, issueId))
			.run();
	}
}

/**
 * The log keeps old rows and hands them to whoever is catching up, so a name in it would outlive
 * the rows it came from. Versions stay as they are. Other members never saw the person's private
 * ops, so dropping those opens no gap they can notice. The newest op stays, whoever's it is,
 * because the next version counts from it.
 */
function scrubLog(db: Db, person: Person, forgotten: schema.MemberRow): void {
	const logged = db
		.select({ version: schema.oplog.version, data: schema.oplog.data })
		.from(schema.oplog)
		.where(sql`instr(${schema.oplog.data}, ${`${MENTION_SCHEME}${person.id})`}) > 0`)
		.all();
	for (const { version, data } of logged) {
		db.update(schema.oplog)
			.set({ data: rewritten(data, person) })
			.where(eq(schema.oplog.version, version))
			.run();
	}
	db.update(schema.oplog)
		.set({ data: toMember(forgotten) })
		.where(
			and(
				eq(schema.oplog.entity, "member"),
				eq(schema.oplog.entityId, person.id),
				eq(schema.oplog.op, "put"),
				isNull(schema.oplog.audience),
			),
		)
		.run();
	db.delete(schema.oplog)
		.where(and(eq(schema.oplog.audience, person.id), lt(schema.oplog.version, currentVersion(db))))
		.run();
}

/**
 * Deliveries are kept a while for settings to show, with the names they went out with. The ones
 * still waiting go out without the name: `deliverDue` reads each one just before sending it, and
 * the signature is made then. What is already on its way to a receiver cannot be called back, any
 * more than what reached it a moment earlier.
 */
function scrubDeliveries(db: Db, person: Person): void {
	const deliveries = db
		.select({ id: schema.webhookDeliveries.id, payload: schema.webhookDeliveries.payload })
		.from(schema.webhookDeliveries)
		.where(sql`instr(${schema.webhookDeliveries.payload}, ${person.id}) > 0`)
		.all();
	for (const { id, payload } of deliveries) {
		db.update(schema.webhookDeliveries)
			.set({ payload: JSON.stringify(rewritten(JSON.parse(payload), person)) })
			.where(eq(schema.webhookDeliveries.id, id))
			.run();
	}
}

/** A value with the person's mentions renamed wherever it holds text, and any `{ id, name }` of theirs. */
function rewritten(value: unknown, person: Person): unknown {
	if (typeof value === "string") return renameMentions(value, person);
	if (Array.isArray(value)) return value.map((item) => rewritten(item, person));
	if (typeof value !== "object" || value === null) return value;
	const copy = Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, rewritten(item, person)]),
	);
	return copy.id === person.id && typeof copy.name === "string"
		? { ...copy, name: person.name }
		: copy;
}
