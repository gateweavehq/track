import {
	addDays,
	CLOSED_STATUSES,
	type CycleSettings,
	cycleEnd,
	dayIn,
	daysBetween,
	SYSTEM_ACTOR_ID,
	startOfDay,
	UPCOMING_CYCLES,
} from "@gateweave/track-protocol";
import { and, asc, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { recordActivity } from "./activity";
import * as schema from "./db/schema";
import { ChangeSet, type WriteResult } from "./log";
import { MutationRejected } from "./rejected";
import { type Db, toCycle, toIssue } from "./state";
import { queueDeliveries } from "./webhooks";

/** A team's cycles as an admin sets them: the settings, and when the next cycle starts. */
export type CycleSchedule = CycleSettings & { startsOn: string };

/** How far ahead an admin may start a team's cycles. */
const MAX_LEAD_DAYS = 366;

/**
 * Applies an admin's change to a team's cycles, inside their mutation; `team` is the row as it was
 * before. Cycles that have started are left as they are. Those that have not are dated anew from
 * `startsOn`, keeping their issues, and more are made to keep {@link UPCOMING_CYCLES} ahead.
 * Turning cycles off completes the running cycle today and deletes the rest; their unfinished
 * issues leave them.
 */
export function scheduleCycles(
	db: Db,
	changes: ChangeSet,
	team: schema.TeamRow,
	schedule: CycleSchedule | null,
	actorId: string,
): void {
	if (schedule === null) {
		if (team.cycles) stopCycles(db, changes, team.id, team.cycles, actorId);
		return;
	}

	const today = dayIn(schedule.timeZone, changes.now);
	const open = openCycles(db, team.id);
	const running = open.filter((cycle) => cycle.startsOn <= today).at(-1);
	const upcoming = open.filter((cycle) => cycle.startsOn > today);
	if (running && schedule.startsOn <= running.endsOn) {
		throw new MutationRejected(
			"invalid",
			`The next cycle has to start after the current one ends: on ${addDays(running.endsOn, 1)} or later`,
		);
	}
	const length = schedule.weeks * 7;
	if (!running && daysBetween(schedule.startsOn, today) >= length) {
		throw new MutationRejected("invalid", "A cycle that starts then would be over already");
	}
	if (daysBetween(today, schedule.startsOn) > MAX_LEAD_DAYS) {
		throw new MutationRejected("invalid", "Cycles can start at most a year ahead");
	}

	let number = lastNumber(db, team.id);
	let startsOn = schedule.startsOn;
	let ahead = 0;
	for (let slot = 0; ahead < UPCOMING_CYCLES || slot < upcoming.length; slot += 1) {
		const endsOn = cycleEnd(startsOn, schedule.weeks);
		const cycle = upcoming[slot];
		if (cycle) {
			if (cycle.startsOn !== startsOn || cycle.endsOn !== endsOn) {
				const row = db
					.update(schema.cycles)
					.set({ startsOn, endsOn, updatedAt: changes.now })
					.where(eq(schema.cycles.id, cycle.id))
					.returning()
					.get();
				if (row) changes.put("cycle", toCycle(row));
			}
		} else {
			number += 1;
			createCycle(db, changes, team.id, number, startsOn, endsOn);
		}
		if (startsOn > today) ahead += 1;
		startsOn = addDays(endsOn, 1);
	}
}

/**
 * Completes the cycles whose last day is over, moving their unfinished issues to the next cycle,
 * and schedules cycles to keep {@link UPCOMING_CYCLES} ahead. The alarm runs it at each team's
 * next cycle boundary; Track itself is the actor.
 */
export function advanceCycles(db: Db, now: number): WriteResult {
	const changes = new ChangeSet(db, null, now);
	const teams = db.select().from(schema.teams).where(isNotNull(schema.teams.cycles)).all();
	for (const team of teams) {
		if (!team.cycles) continue;
		const today = dayIn(team.cycles.timeZone, now);
		extendCycles(db, changes, team.id, team.cycles, today);
		const open = openCycles(db, team.id);
		for (const [index, cycle] of open.entries()) {
			if (cycle.endsOn >= today) break;
			completeCycle(db, changes, cycle, open[index + 1]?.id ?? null, SYSTEM_ACTOR_ID);
		}
	}
	const result = changes.result();
	const queued = queueDeliveries(db, null, changes.events, result.version, now);
	return { ...result, queued };
}

/**
 * When {@link advanceCycles} next has something to do: the next midnight, in a team's time zone,
 * on which one of its cycles starts or ends. Null when no team has cycles on.
 */
export function nextCycleChange(db: Db, now: number): number | null {
	let next: number | null = null;
	const teams = db.select().from(schema.teams).where(isNotNull(schema.teams.cycles)).all();
	for (const team of teams) {
		if (!team.cycles) continue;
		const today = dayIn(team.cycles.timeZone, now);
		let day: string | null = null;
		for (const cycle of openCycles(db, team.id)) {
			const boundary = cycle.startsOn > today ? cycle.startsOn : addDays(cycle.endsOn, 1);
			if (day === null || boundary < day) day = boundary;
		}
		if (day === null) continue;
		const at = day <= today ? now : startOfDay(team.cycles.timeZone, day);
		if (next === null || at < next) next = at;
	}
	return next;
}

/** A team's cycles that have not completed, in order. */
function openCycles(db: Db, teamId: string): schema.CycleRow[] {
	return db
		.select()
		.from(schema.cycles)
		.where(and(eq(schema.cycles.teamId, teamId), isNull(schema.cycles.completedAt)))
		.orderBy(asc(schema.cycles.number))
		.all();
}

function lastNumber(db: Db, teamId: string): number {
	const last = db
		.select({ number: schema.cycles.number })
		.from(schema.cycles)
		.where(eq(schema.cycles.teamId, teamId))
		.orderBy(asc(schema.cycles.number))
		.all()
		.at(-1);
	return last?.number ?? 0;
}

function createCycle(
	db: Db,
	changes: ChangeSet,
	teamId: string,
	number: number,
	startsOn: string,
	endsOn: string,
): void {
	const row: schema.CycleRow = {
		id: crypto.randomUUID(),
		teamId,
		number,
		name: null,
		startsOn,
		endsOn,
		completedAt: null,
		createdAt: changes.now,
		updatedAt: changes.now,
	};
	db.insert(schema.cycles).values(row).run();
	changes.put("cycle", toCycle(row));
}

/**
 * Makes cycles after the team's last one until {@link UPCOMING_CYCLES} start after today. A
 * workspace that slept through whole cycles skips them, keeping the rhythm, rather than making
 * cycles that would complete at once.
 */
function extendCycles(
	db: Db,
	changes: ChangeSet,
	teamId: string,
	settings: CycleSettings,
	today: string,
): void {
	const all = db
		.select()
		.from(schema.cycles)
		.where(eq(schema.cycles.teamId, teamId))
		.orderBy(asc(schema.cycles.number))
		.all();
	const latest = all.at(-1);
	// Only an admin starts a team's cycles; until then there is nothing to follow.
	if (!latest) return;
	let { number, endsOn } = latest;
	let ahead = all.filter((cycle) => cycle.startsOn > today).length;
	const length = settings.weeks * 7;
	while (ahead < UPCOMING_CYCLES) {
		let startsOn = addDays(endsOn, 1);
		const behind = daysBetween(startsOn, today);
		if (behind >= length) startsOn = addDays(startsOn, behind - (behind % length));
		number += 1;
		endsOn = cycleEnd(startsOn, settings.weeks);
		createCycle(db, changes, teamId, number, startsOn, endsOn);
		if (startsOn > today) ahead += 1;
	}
}

/** Completes a cycle and moves its unfinished issues to `nextId`, or out of cycles. */
function completeCycle(
	db: Db,
	changes: ChangeSet,
	cycle: schema.CycleRow,
	nextId: string | null,
	actorId: string,
	endsOn = cycle.endsOn,
): void {
	const row = db
		.update(schema.cycles)
		.set({ completedAt: changes.now, endsOn, updatedAt: changes.now })
		.where(eq(schema.cycles.id, cycle.id))
		.returning()
		.get();
	if (row) changes.put("cycle", toCycle(row));
	const unfinished = db
		.select()
		.from(schema.issues)
		.where(
			and(
				eq(schema.issues.cycleId, cycle.id),
				isNull(schema.issues.deletedAt),
				notInArray(schema.issues.status, [...CLOSED_STATUSES]),
			),
		)
		.all();
	moveIssues(db, changes, unfinished, nextId, actorId);
}

function stopCycles(
	db: Db,
	changes: ChangeSet,
	teamId: string,
	settings: CycleSettings,
	actorId: string,
): void {
	const today = dayIn(settings.timeZone, changes.now);
	for (const cycle of openCycles(db, teamId)) {
		if (cycle.startsOn <= today) {
			// One whose last day is over keeps it; a running one ends today.
			const over = cycle.endsOn < today;
			completeCycle(db, changes, cycle, null, actorId, over ? cycle.endsOn : today);
			continue;
		}
		const planned = db
			.select()
			.from(schema.issues)
			.where(and(eq(schema.issues.cycleId, cycle.id), isNull(schema.issues.deletedAt)))
			.all();
		moveIssues(db, changes, planned, null, actorId);
		db.delete(schema.cycles).where(eq(schema.cycles.id, cycle.id)).run();
		changes.delete("cycle", cycle.id);
	}
}

/**
 * Moves issues to another cycle, or out of cycles, with a history entry each. The field is not
 * stamped, so someone who moves an issue at the same moment still gets their way.
 */
function moveIssues(
	db: Db,
	changes: ChangeSet,
	issues: schema.IssueRow[],
	cycleId: string | null,
	actorId: string,
): void {
	for (const issue of issues) {
		const row = db
			.update(schema.issues)
			.set({ cycleId, version: changes.nextVersion, updatedAt: changes.now })
			.where(eq(schema.issues.id, issue.id))
			.returning()
			.get();
		if (!row) continue;
		changes.put("issue", toIssue(row));
		changes.events.push({ type: "issue.updated", issue: row, previous: issue });
		recordActivity(db, changes, issue, actorId, {
			type: "cycle",
			from: issue.cycleId,
			to: cycleId,
		});
	}
}
