import {
	type ActivityChange,
	isAdminRole,
	MAX_LABELS_PER_ISSUE,
	type Mutation,
	type MutationArgs,
} from "@gateweave/track-protocol";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { recordActivity } from "./activity";
import * as schema from "./db/schema";
import { ChangeSet, type WriteResult } from "./log";
import { MutationRejected } from "./rejected";
import { indexIssue, indexTeamIssues, unindexIssue } from "./search";
import { activeMember, type Db, toComment, toIssue, toLabel, toTeam } from "./state";
import { queueDeliveries } from "./webhooks";

export interface Actor {
	member: schema.MemberRow;
	clientId: string;
}

/**
 * Applies a client mutation. Must run inside a storage transaction so a rejection rolls back
 * every write. Re-applying a mutation id returns the original version without writing again.
 */
export function applyMutation(
	db: Db,
	actor: Actor,
	mutationId: string,
	mutation: Mutation,
	now: number,
): WriteResult {
	const applied = db
		.select()
		.from(schema.appliedMutations)
		.where(eq(schema.appliedMutations.id, mutationId))
		.get();
	if (applied) {
		if (applied.clientId !== actor.clientId) {
			throw new MutationRejected("invalid", "Mutation id was already used by another client");
		}
		return { version: applied.version, ops: [] };
	}

	const changes = new ChangeSet(db, actor.member.userId, now);
	switch (mutation.name) {
		case "team.create":
			createTeam(db, changes, actor, mutation.args);
			break;
		case "team.update":
			updateTeam(db, changes, actor, mutation.args);
			break;
		case "issue.create":
			createIssue(db, changes, actor, mutation.args);
			break;
		case "issue.update":
			updateIssue(db, changes, actor, mutation.args);
			break;
		case "issue.delete":
			deleteIssue(db, changes, mutation.args);
			break;
		case "issue.addLabel":
			addLabel(db, changes, actor, mutation.args);
			break;
		case "issue.removeLabel":
			removeLabel(db, changes, actor, mutation.args);
			break;
		case "label.create":
			createLabel(db, changes, mutation.args);
			break;
		case "label.update":
			updateLabel(db, changes, mutation.args);
			break;
		case "label.delete":
			deleteLabel(db, changes, actor, mutation.args);
			break;
		case "comment.create":
			createComment(db, changes, actor, mutation.args);
			break;
		case "comment.update":
			updateComment(db, changes, actor, mutation.args);
			break;
		case "comment.delete":
			deleteComment(db, changes, actor, mutation.args);
			break;
	}

	const result = changes.result();
	db.insert(schema.appliedMutations)
		.values({ id: mutationId, clientId: actor.clientId, version: result.version, at: now })
		.run();
	const queued = queueDeliveries(db, actor.member, changes.events, result.version, now);
	return { ...result, queued };
}

function createTeam(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"team.create">) {
	requireAdmin(actor, "Only workspace admins can manage teams");
	if (findTeam(db, args.id)) throw new MutationRejected("invalid", "Team id already exists");
	assertTeamKeyFree(db, args.key);

	const row: schema.TeamRow = {
		...args,
		issueCounter: 0,
		createdAt: changes.now,
		updatedAt: changes.now,
	};
	db.insert(schema.teams).values(row).run();
	changes.put("team", toTeam(row));
}

function updateTeam(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"team.update">) {
	requireAdmin(actor, "Only workspace admins can manage teams");
	const team = findTeam(db, args.id);
	if (!team) throw new MutationRejected("not_found", "Team not found");
	if (args.patch.key && args.patch.key !== team.key) assertTeamKeyFree(db, args.patch.key, team.id);

	const row = db
		.update(schema.teams)
		.set({ ...args.patch, updatedAt: changes.now })
		.where(eq(schema.teams.id, team.id))
		.returning()
		.get();
	if (row) changes.put("team", toTeam(row));
	// The team's issue keys changed with it.
	if (row && row.key !== team.key) indexTeamIssues(db, team.id);
}

function createIssue(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"issue.create">) {
	const team = findTeam(db, args.teamId);
	if (!team) throw new MutationRejected("not_found", "Team not found");
	if (db.select().from(schema.issues).where(eq(schema.issues.id, args.id)).get()) {
		throw new MutationRejected("invalid", "Issue id already exists");
	}
	assertAssignable(db, args.assigneeId);
	const labelIds = [...new Set(args.labelIds)];
	for (const labelId of labelIds) {
		if (!findLiveLabel(db, labelId)) throw new MutationRejected("not_found", "Label not found");
	}

	const number = team.issueCounter + 1;
	db.update(schema.teams).set({ issueCounter: number }).where(eq(schema.teams.id, team.id)).run();

	const row: schema.IssueRow = {
		...args,
		labelIds,
		number,
		creatorId: actor.member.userId,
		version: changes.nextVersion,
		// Fields without a stamp were last written at creation, which every client has seen.
		fieldStamps: {},
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(schema.issues).values(row).run();
	indexIssue(db, row.id);
	changes.put("issue", toIssue(row));
	changes.events.push({ type: "issue.created", issue: row });
}

/**
 * Field-level optimistic concurrency: each field in the patch is applied unless another client
 * wrote that field after `baseVersion`. A client's own earlier writes never conflict with its
 * later ones, so rapid successive edits from one tab all land. If every field conflicts, the
 * whole mutation is rejected.
 */
function updateIssue(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"issue.update">) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");
	if (args.patch.assigneeId !== undefined) assertAssignable(db, args.patch.assigneeId);

	const version = changes.nextVersion;
	const accepted: Partial<schema.IssueRow> = {};
	const stamps = { ...issue.fieldStamps };
	let conflicted = false;

	for (const [field, value] of Object.entries(args.patch) as [keyof typeof args.patch, never][]) {
		const stamp = issue.fieldStamps[field];
		if (stamp && stamp.version > args.baseVersion && stamp.clientId !== actor.clientId) {
			conflicted = true;
			continue;
		}
		if (issue[field] === value) continue;
		accepted[field] = value;
		stamps[field] = { version, clientId: actor.clientId };
	}

	if (Object.keys(accepted).length === 0) {
		if (conflicted) {
			throw new MutationRejected("conflict", "Another client changed these fields first");
		}
		return;
	}

	const row = db
		.update(schema.issues)
		.set({ ...accepted, fieldStamps: stamps, version, updatedAt: changes.now })
		.where(eq(schema.issues.id, issue.id))
		.returning()
		.get();
	if (row) {
		changes.put("issue", toIssue(row));
		changes.events.push({ type: "issue.updated", issue: row, previous: issue });
	}
	if (accepted.title !== undefined || accepted.description !== undefined) {
		indexIssue(db, issue.id);
	}
	// After the issue's own op, so the issue's version stays the version that wrote it.
	for (const change of issueChanges(issue, accepted)) {
		recordActivity(db, changes, issue, actor.member.userId, change);
	}
}

/** What a patch changed, as history. Manual ordering is not history. */
function issueChanges(before: schema.IssueRow, patch: Partial<schema.IssueRow>): ActivityChange[] {
	const changes: ActivityChange[] = [];
	if (patch.status !== undefined) {
		changes.push({ type: "status", from: before.status, to: patch.status });
	}
	if (patch.priority !== undefined) {
		changes.push({ type: "priority", from: before.priority, to: patch.priority });
	}
	if (patch.assigneeId !== undefined) {
		changes.push({ type: "assignee", from: before.assigneeId, to: patch.assigneeId });
	}
	if (patch.title !== undefined)
		changes.push({ type: "title", from: before.title, to: patch.title });
	if (patch.description !== undefined) changes.push({ type: "description" });
	return changes;
}

/**
 * The issue's comments and history go with it. Their rows stay, like the issue's, but clients are
 * told to drop them, since a snapshot leaves out everything that belongs to a deleted issue.
 */
function deleteIssue(db: Db, changes: ChangeSet, args: MutationArgs<"issue.delete">) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");

	const comments = db
		.select({ id: schema.comments.id })
		.from(schema.comments)
		.where(and(eq(schema.comments.issueId, issue.id), isNull(schema.comments.deletedAt)))
		.all();
	for (const comment of comments) changes.delete("comment", comment.id);
	const activities = db
		.select({ id: schema.activities.id })
		.from(schema.activities)
		.where(eq(schema.activities.issueId, issue.id))
		.all();
	for (const activity of activities) changes.delete("activity", activity.id);

	db.update(schema.issues)
		.set({ deletedAt: changes.now, version: changes.nextVersion, updatedAt: changes.now })
		.where(eq(schema.issues.id, issue.id))
		.run();
	unindexIssue(db, issue.id);
	changes.delete("issue", issue.id);
	changes.events.push({ type: "issue.deleted", issue });
}

/** Labels are sets, so adding one that is already there, or removing one that is not, is a no-op. */
function addLabel(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"issue.addLabel">) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");
	if (!findLiveLabel(db, args.labelId)) throw new MutationRejected("not_found", "Label not found");
	if (issue.labelIds.includes(args.labelId)) return;
	if (issue.labelIds.length >= MAX_LABELS_PER_ISSUE) {
		throw new MutationRejected(
			"invalid",
			`An issue can have at most ${MAX_LABELS_PER_ISSUE} labels`,
		);
	}
	writeIssueLabels(db, changes, issue, [...issue.labelIds, args.labelId]);
	recordActivity(db, changes, issue, actor.member.userId, {
		type: "label",
		labelId: args.labelId,
		added: true,
	});
}

function removeLabel(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"issue.removeLabel">,
) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");
	if (!issue.labelIds.includes(args.labelId)) return;
	writeIssueLabels(
		db,
		changes,
		issue,
		issue.labelIds.filter((id) => id !== args.labelId),
	);
	recordActivity(db, changes, issue, actor.member.userId, {
		type: "label",
		labelId: args.labelId,
		added: false,
	});
}

function writeIssueLabels(db: Db, changes: ChangeSet, issue: schema.IssueRow, labelIds: string[]) {
	const row = db
		.update(schema.issues)
		.set({ labelIds, version: changes.nextVersion, updatedAt: changes.now })
		.where(eq(schema.issues.id, issue.id))
		.returning()
		.get();
	if (row) {
		changes.put("issue", toIssue(row));
		changes.events.push({ type: "issue.updated", issue: row, previous: issue });
	}
}

function createLabel(db: Db, changes: ChangeSet, args: MutationArgs<"label.create">) {
	if (db.select().from(schema.labels).where(eq(schema.labels.id, args.id)).get()) {
		throw new MutationRejected("invalid", "Label id already exists");
	}
	assertLabelNameFree(db, args.name);

	const row: schema.LabelRow = {
		...args,
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(schema.labels).values(row).run();
	changes.put("label", toLabel(row));
}

function updateLabel(db: Db, changes: ChangeSet, args: MutationArgs<"label.update">) {
	const label = findLiveLabel(db, args.id);
	if (!label) throw new MutationRejected("not_found", "Label not found");
	if (args.patch.name !== undefined) assertLabelNameFree(db, args.patch.name, label.id);

	const row = db
		.update(schema.labels)
		.set({ ...args.patch, updatedAt: changes.now })
		.where(eq(schema.labels.id, label.id))
		.returning()
		.get();
	if (row) changes.put("label", toLabel(row));
}

/** Removes the label from every issue that has it, then deletes it. Admins only: it is wide. */
function deleteLabel(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"label.delete">) {
	requireAdmin(actor, "Only workspace admins can delete labels");
	const label = findLiveLabel(db, args.id);
	if (!label) throw new MutationRejected("not_found", "Label not found");

	const labeled = db
		.select()
		.from(schema.issues)
		.where(
			and(
				isNull(schema.issues.deletedAt),
				sql`exists (select 1 from json_each(${schema.issues.labelIds}) where value = ${label.id})`,
			),
		)
		.all();
	for (const issue of labeled) {
		writeIssueLabels(
			db,
			changes,
			issue,
			issue.labelIds.filter((id) => id !== label.id),
		);
	}

	db.update(schema.labels)
		.set({ deletedAt: changes.now, updatedAt: changes.now })
		.where(eq(schema.labels.id, label.id))
		.run();
	changes.delete("label", label.id);
}

function createComment(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"comment.create">,
) {
	if (!findLiveIssue(db, args.issueId)) throw new MutationRejected("not_found", "Issue not found");
	if (db.select().from(schema.comments).where(eq(schema.comments.id, args.id)).get()) {
		throw new MutationRejected("invalid", "Comment id already exists");
	}

	const row: schema.CommentRow = {
		...args,
		authorId: actor.member.userId,
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(schema.comments).values(row).run();
	indexIssue(db, row.issueId);
	changes.put("comment", toComment(row));
	changes.events.push({ type: "comment.created", comment: row });
}

/** A comment says what its author said, so nobody else can change it, admins included. */
function updateComment(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"comment.update">,
) {
	const comment = findLiveComment(db, args.id);
	if (!comment) throw new MutationRejected("not_found", "Comment not found");
	if (comment.authorId !== actor.member.userId) {
		throw new MutationRejected("forbidden", "Only the author can edit a comment");
	}
	if (comment.body === args.body) return;

	const row = db
		.update(schema.comments)
		.set({ body: args.body, updatedAt: changes.now })
		.where(eq(schema.comments.id, comment.id))
		.returning()
		.get();
	indexIssue(db, comment.issueId);
	if (row) {
		changes.put("comment", toComment(row));
		changes.events.push({ type: "comment.updated", comment: row });
	}
}

/** Admins can delete anyone's comment, for moderation. */
function deleteComment(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"comment.delete">,
) {
	const comment = findLiveComment(db, args.id);
	if (!comment) throw new MutationRejected("not_found", "Comment not found");
	if (comment.authorId !== actor.member.userId) {
		requireAdmin(actor, "Only the author or an admin can delete a comment");
	}

	db.update(schema.comments)
		.set({ deletedAt: changes.now, updatedAt: changes.now })
		.where(eq(schema.comments.id, comment.id))
		.run();
	indexIssue(db, comment.issueId);
	changes.delete("comment", comment.id);
	changes.events.push({ type: "comment.deleted", comment });
}

function requireAdmin(actor: Actor, message: string) {
	if (!isAdminRole(actor.member.role)) throw new MutationRejected("forbidden", message);
}

function findTeam(db: Db, id: string) {
	return db.select().from(schema.teams).where(eq(schema.teams.id, id)).get();
}

function findLiveIssue(db: Db, id: string) {
	const issue = db.select().from(schema.issues).where(eq(schema.issues.id, id)).get();
	return issue && issue.deletedAt === null ? issue : undefined;
}

/** A comment is live while it and its issue are. */
function findLiveComment(db: Db, id: string) {
	const comment = db
		.select()
		.from(schema.comments)
		.where(and(eq(schema.comments.id, id), isNull(schema.comments.deletedAt)))
		.get();
	return comment && findLiveIssue(db, comment.issueId) ? comment : undefined;
}

function findLiveLabel(db: Db, id: string) {
	return db
		.select()
		.from(schema.labels)
		.where(and(eq(schema.labels.id, id), isNull(schema.labels.deletedAt)))
		.get();
}

/** Compared in JavaScript, because SQLite's lower() only folds ASCII. */
function assertLabelNameFree(db: Db, name: string, exceptLabelId?: string) {
	const folded = name.toLowerCase();
	const taken = db
		.select({ id: schema.labels.id, name: schema.labels.name })
		.from(schema.labels)
		.where(isNull(schema.labels.deletedAt))
		.all()
		.some((label) => label.id !== exceptLabelId && label.name.toLowerCase() === folded);
	if (taken) throw new MutationRejected("conflict", `A label named "${name}" already exists`);
}

function assertTeamKeyFree(db: Db, key: string, exceptTeamId?: string) {
	const taken = db
		.select({ id: schema.teams.id })
		.from(schema.teams)
		.where(
			exceptTeamId
				? and(eq(schema.teams.key, key), ne(schema.teams.id, exceptTeamId))
				: eq(schema.teams.key, key),
		)
		.get();
	if (taken) throw new MutationRejected("conflict", `Team key ${key} is already in use`);
}

function assertAssignable(db: Db, assigneeId: string | null) {
	if (assigneeId !== null && !activeMember(db, assigneeId)) {
		throw new MutationRejected("invalid", "Assignee is not a workspace member");
	}
}
