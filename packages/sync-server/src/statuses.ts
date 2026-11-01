import {
	compareStatuses,
	defaultStatuses,
	firstStatus,
	isClosedCategory,
	MAX_STATUSES_PER_TEAM,
	type MutationArgs,
	type StatusCategory,
	statusId,
} from "@gateweave/track-protocol";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { recordActivity } from "./activity";
import * as schema from "./db/schema";
import type { ChangeSet } from "./log";
import { MutationRejected } from "./rejected";
import { type Db, toIssue, toStatus } from "./state";

/** A team's statuses, removed ones included, in its order. */
export function teamStatuses(db: Db, teamId: string): schema.StatusRow[] {
	return db
		.select()
		.from(schema.statuses)
		.where(eq(schema.statuses.teamId, teamId))
		.all()
		.sort(compareStatuses);
}

/** A live status of the team, by key. */
export function findLiveStatus(db: Db, teamId: string, key: string): schema.StatusRow | undefined {
	return db
		.select()
		.from(schema.statuses)
		.where(and(eq(schema.statuses.id, statusId(teamId, key)), isNull(schema.statuses.removedAt)))
		.get();
}

/** The status's category, or undefined for a key the team does not have. */
export function categoryOf(db: Db, teamId: string, key: string): StatusCategory | undefined {
	return db
		.select({ category: schema.statuses.category })
		.from(schema.statuses)
		.where(eq(schema.statuses.id, statusId(teamId, key)))
		.get()?.category;
}

/** Whether the status closes an issue: one of the completed or canceled category. */
export function isClosedStatus(db: Db, teamId: string, key: string): boolean {
	const category = categoryOf(db, teamId, key);
	return category !== undefined && isClosedCategory(category);
}

/** The keys of the team's statuses that close an issue, removed ones included. */
export function closedKeys(db: Db, teamId: string): string[] {
	return teamStatuses(db, teamId)
		.filter((status) => isClosedCategory(status.category))
		.map((status) => status.key);
}

/** The status a new issue of the team gets when it names none. */
export function defaultStatusKey(db: Db, teamId: string): string {
	const status = firstStatus(teamStatuses(db, teamId));
	// A team always keeps a completed status, so it is never without one.
	if (!status) throw new MutationRejected("invalid", "The team has no statuses");
	return status.key;
}

export function assertStatus(db: Db, teamId: string, key: string): void {
	if (!findLiveStatus(db, teamId, key)) {
		throw new MutationRejected("invalid", `"${key}" is not one of the team's statuses`);
	}
}

/** Gives a new team the statuses every team starts with. */
export function seedStatuses(db: Db, changes: ChangeSet, teamId: string): void {
	for (const status of defaultStatuses(teamId, changes.now)) {
		db.insert(schema.statuses).values(status).run();
		changes.put("status", status);
	}
}

export function createStatus(
	db: Db,
	changes: ChangeSet,
	args: MutationArgs<"status.create">,
): void {
	const team = db.select().from(schema.teams).where(eq(schema.teams.id, args.teamId)).get();
	if (!team) throw new MutationRejected("not_found", "Team not found");
	const statuses = teamStatuses(db, team.id);
	if (statuses.some((status) => status.key === args.key)) {
		throw new MutationRejected("conflict", "The team already has a status with that key");
	}
	const live = statuses.filter((status) => status.removedAt === null);
	if (live.length >= MAX_STATUSES_PER_TEAM) {
		throw new MutationRejected("invalid", `A team has at most ${MAX_STATUSES_PER_TEAM} statuses`);
	}
	assertNameFree(live, args.name);

	const row: schema.StatusRow = {
		...args,
		id: statusId(team.id, args.key),
		createdAt: changes.now,
		updatedAt: changes.now,
		removedAt: null,
	};
	db.insert(schema.statuses).values(row).run();
	changes.put("status", toStatus(row));
}

export function updateStatus(
	db: Db,
	changes: ChangeSet,
	actorId: string,
	args: MutationArgs<"status.update">,
): void {
	const status = findLiveStatus(db, args.teamId, args.key);
	if (!status) throw new MutationRejected("not_found", "Status not found");
	const others = teamStatuses(db, args.teamId).filter(
		(other) => other.removedAt === null && other.key !== status.key,
	);
	if (args.patch.name !== undefined) assertNameFree(others, args.patch.name);
	if (args.patch.category !== undefined && args.patch.category !== status.category) {
		assertKeepsCompleted(others, status);
	}
	const row = db
		.update(schema.statuses)
		.set({ ...args.patch, updatedAt: changes.now })
		.where(eq(schema.statuses.id, status.id))
		.returning()
		.get();
	if (row) changes.put("status", toStatus(row));
	if (
		args.patch.category !== undefined &&
		isClosedCategory(status.category) &&
		!isClosedCategory(args.patch.category)
	) {
		restoreArchived(db, changes, args.teamId, status.key);
	}
	if (
		args.patch.category !== undefined &&
		!isClosedCategory(status.category) &&
		isClosedCategory(args.patch.category)
	) {
		declineRequests(db, changes, actorId, args.teamId, status.key);
	}
}

/**
 * Takes the team's requests in a status that now closes them out of intake, as declined: a
 * request is never closed. Like the change to the workflow that caused it, nobody's inbox hears
 * of it.
 */
function declineRequests(
	db: Db,
	changes: ChangeSet,
	actorId: string,
	teamId: string,
	key: string,
): void {
	const requests = db
		.select()
		.from(schema.issues)
		.where(
			and(
				eq(schema.issues.teamId, teamId),
				eq(schema.issues.status, key),
				eq(schema.issues.intake, true),
				isNull(schema.issues.deletedAt),
			),
		)
		.all();
	for (const issue of requests) {
		const row = db
			.update(schema.issues)
			.set({ intake: false, version: changes.nextVersion, updatedAt: changes.now })
			.where(eq(schema.issues.id, issue.id))
			.returning()
			.get();
		if (!row) continue;
		changes.put("issue", toIssue(row));
		changes.events.push({ type: "issue.updated", issue: row, previous: issue, quiet: true });
		recordActivity(db, changes, issue, actorId, { type: "intake", accepted: false });
	}
}

/**
 * Restores the team's archived issues in a status that no longer closes them, as reopening one
 * does: an open issue is never archived. Like the change to the workflow that caused it, nobody's
 * inbox hears of it.
 */
function restoreArchived(db: Db, changes: ChangeSet, teamId: string, key: string): void {
	const archived = db
		.select()
		.from(schema.issues)
		.where(
			and(
				eq(schema.issues.teamId, teamId),
				eq(schema.issues.status, key),
				isNotNull(schema.issues.archivedAt),
				isNull(schema.issues.deletedAt),
			),
		)
		.all();
	for (const issue of archived) {
		const row = db
			.update(schema.issues)
			.set({ archivedAt: null, version: changes.nextVersion, updatedAt: changes.now })
			.where(eq(schema.issues.id, issue.id))
			.returning()
			.get();
		if (!row) continue;
		changes.put("issue", toIssue(row));
		changes.events.push({ type: "issue.updated", issue: row, previous: issue, quiet: true });
	}
}

/**
 * Removes a status, moving the team's live issues in it to another, with a history entry each
 * and webhooks as for any change. It is the admin's change to the team's workflow rather than to
 * the issues, so nobody's inbox hears of it.
 */
export function deleteStatus(
	db: Db,
	changes: ChangeSet,
	actorId: string,
	args: MutationArgs<"status.delete">,
): void {
	const status = findLiveStatus(db, args.teamId, args.key);
	if (!status) throw new MutationRejected("not_found", "Status not found");
	if (args.moveTo === args.key) {
		throw new MutationRejected("invalid", "Move its issues to another status");
	}
	if (!findLiveStatus(db, args.teamId, args.moveTo)) {
		throw new MutationRejected("invalid", `"${args.moveTo}" is not one of the team's statuses`);
	}
	const others = teamStatuses(db, args.teamId).filter(
		(other) => other.removedAt === null && other.key !== status.key,
	);
	assertKeepsCompleted(others, status);

	const row = db
		.update(schema.statuses)
		.set({ removedAt: changes.now, updatedAt: changes.now })
		.where(eq(schema.statuses.id, status.id))
		.returning()
		.get();
	if (row) changes.put("status", toStatus(row));

	const issues = db
		.select()
		.from(schema.issues)
		.where(
			and(
				eq(schema.issues.teamId, args.teamId),
				eq(schema.issues.status, status.key),
				isNull(schema.issues.deletedAt),
			),
		)
		.all();
	// Moved into a status that does not close them, archived issues are restored; moved into one
	// that does, requests leave intake as declined, since a request is never closed.
	const reopens = !isClosedStatus(db, args.teamId, args.moveTo);
	for (const issue of issues) {
		// Stamped like any status change, so an offline edit made before it conflicts instead of
		// putting the issue back in a status that is gone.
		const moved = db
			.update(schema.issues)
			.set({
				status: args.moveTo,
				...(reopens ? { archivedAt: null } : { intake: false }),
				fieldStamps: {
					...issue.fieldStamps,
					status: { version: changes.nextVersion, clientId: `status:${status.id}` },
				},
				version: changes.nextVersion,
				updatedAt: changes.now,
			})
			.where(eq(schema.issues.id, issue.id))
			.returning()
			.get();
		if (!moved) continue;
		changes.put("issue", toIssue(moved));
		changes.events.push({ type: "issue.updated", issue: moved, previous: issue, quiet: true });
		recordActivity(db, changes, issue, actorId, {
			type: "status",
			from: issue.status,
			to: args.moveTo,
		});
		if (issue.intake && !moved.intake) {
			recordActivity(db, changes, issue, actorId, { type: "intake", accepted: false });
		}
	}
}

function assertNameFree(statuses: schema.StatusRow[], name: string): void {
	const wanted = name.trim().toLowerCase();
	if (statuses.some((status) => status.name.toLowerCase() === wanted)) {
		throw new MutationRejected("conflict", "The team already has a status with that name");
	}
}

/** A team keeps a completed status, for Track and GitHub to close its issues with. */
function assertKeepsCompleted(others: schema.StatusRow[], status: schema.StatusRow): void {
	if (status.category !== "completed") return;
	if (!others.some((other) => other.category === "completed")) {
		throw new MutationRejected("invalid", "A team needs at least one completed status");
	}
}
