import {
	MAX_LABELS_PER_ISSUE,
	type Mutation,
	type MutationArgs,
	type RejectReason,
} from "@gateweave/track-protocol";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import { ChangeSet, type WriteResult } from "./log";
import { activeMember, type Db, toIssue, toLabel, toTeam } from "./state";

export class MutationRejected extends Error {
	constructor(
		readonly reason: RejectReason,
		message: string,
	) {
		super(message);
		this.name = "MutationRejected";
	}
}

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
			addLabel(db, changes, mutation.args);
			break;
		case "issue.removeLabel":
			removeLabel(db, changes, mutation.args);
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
	}

	const result = changes.result();
	db.insert(schema.appliedMutations)
		.values({ id: mutationId, clientId: actor.clientId, version: result.version, at: now })
		.run();
	return result;
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
	changes.put("issue", toIssue(row));
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
	if (row) changes.put("issue", toIssue(row));
}

function deleteIssue(db: Db, changes: ChangeSet, args: MutationArgs<"issue.delete">) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");

	db.update(schema.issues)
		.set({ deletedAt: changes.now, version: changes.nextVersion, updatedAt: changes.now })
		.where(eq(schema.issues.id, issue.id))
		.run();
	changes.delete("issue", issue.id);
}

/** Labels are sets, so adding one that is already there, or removing one that is not, is a no-op. */
function addLabel(db: Db, changes: ChangeSet, args: MutationArgs<"issue.addLabel">) {
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
}

function removeLabel(db: Db, changes: ChangeSet, args: MutationArgs<"issue.removeLabel">) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");
	if (!issue.labelIds.includes(args.labelId)) return;
	writeIssueLabels(
		db,
		changes,
		issue,
		issue.labelIds.filter((id) => id !== args.labelId),
	);
}

function writeIssueLabels(db: Db, changes: ChangeSet, issue: schema.IssueRow, labelIds: string[]) {
	const row = db
		.update(schema.issues)
		.set({ labelIds, version: changes.nextVersion, updatedAt: changes.now })
		.where(eq(schema.issues.id, issue.id))
		.returning()
		.get();
	if (row) changes.put("issue", toIssue(row));
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

function requireAdmin(actor: Actor, message: string) {
	if (actor.member.role === "member") throw new MutationRejected("forbidden", message);
}

function findTeam(db: Db, id: string) {
	return db.select().from(schema.teams).where(eq(schema.teams.id, id)).get();
}

function findLiveIssue(db: Db, id: string) {
	const issue = db.select().from(schema.issues).where(eq(schema.issues.id, id)).get();
	return issue && issue.deletedAt === null ? issue : undefined;
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
