import type { Mutation, MutationArgs, RejectReason } from "@gateweave/track-protocol";
import { and, eq, ne } from "drizzle-orm";
import * as schema from "./db/schema";
import { ChangeSet, type WriteResult } from "./log";
import { activeMember, type Db, toIssue, toTeam } from "./state";

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
	}

	const result = changes.result();
	db.insert(schema.appliedMutations)
		.values({ id: mutationId, clientId: actor.clientId, version: result.version, at: now })
		.run();
	return result;
}

function createTeam(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"team.create">) {
	requireAdmin(actor);
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
	requireAdmin(actor);
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

	const number = team.issueCounter + 1;
	db.update(schema.teams).set({ issueCounter: number }).where(eq(schema.teams.id, team.id)).run();

	const row: schema.IssueRow = {
		...args,
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

function requireAdmin(actor: Actor) {
	if (actor.member.role === "member") {
		throw new MutationRejected("forbidden", "Only workspace admins can manage teams");
	}
}

function findTeam(db: Db, id: string) {
	return db.select().from(schema.teams).where(eq(schema.teams.id, id)).get();
}

function findLiveIssue(db: Db, id: string) {
	const issue = db.select().from(schema.issues).where(eq(schema.issues.id, id)).get();
	return issue && issue.deletedAt === null ? issue : undefined;
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
