import { runInDurableObject } from "cloudflare:test";
import {
	addDays,
	type Cycle,
	dayIn,
	daysBetween,
	type MutationInput,
	SYSTEM_ACTOR_ID,
	startOfDay,
} from "@gateweave/track-protocol";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, vi } from "vitest";
import type { MemberProfile } from "../src";
import { advanceCycles, nextCycleChange } from "../src/cycles";
import * as schema from "../src/db/schema";
import { freshWorkspace, TestClient, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };

const TEAM_ID = "team-eng";
const ZONE = "Europe/Istanbul";

type Schedule = { weeks: number; timeZone: string; startsOn: string } | null;

async function withTeam() {
	const workspace = freshWorkspace();
	const admin = await TestClient.live(workspace, owner);
	await admin.apply({
		name: "team.create",
		args: { id: TEAM_ID, key: "ENG", name: "Engineering" },
	});
	return { workspace, admin };
}

function setCycles(client: TestClient, cycles: Schedule, teamId = TEAM_ID) {
	return client.mutate({ name: "team.update", args: { id: teamId, patch: { cycles } } });
}

async function cyclesOf(workspace: Workspace, teamId = TEAM_ID): Promise<Cycle[]> {
	const snapshot = await workspace.snapshot(owner);
	return snapshot.cycles.filter((cycle) => cycle.teamId === teamId);
}

async function issueIn(workspace: Workspace, id: string) {
	const snapshot = await workspace.snapshot(owner);
	return snapshot.issues.find((issue) => issue.id === id);
}

function createIssue(client: TestClient, id: string, fields: Record<string, unknown> = {}) {
	return client.apply({
		name: "issue.create",
		args: { id, teamId: TEAM_ID, title: `Issue ${id}`, sortOrder: "a0", ...fields },
	} as MutationInput);
}

/** Runs the cycle step as the alarm would at `at`, instead of waiting for the day to come. */
async function advanceAt(workspace: Workspace, at: number) {
	await runInDurableObject(workspace, (_, state) => {
		state.storage.transactionSync(() => advanceCycles(drizzle(state.storage, { schema }), at));
	});
}

function today(timeZone = ZONE) {
	return dayIn(timeZone, Date.now());
}

describe("days in a time zone", () => {
	it("reads the day and finds when it begins", () => {
		expect(dayIn(ZONE, Date.UTC(2026, 10, 1, 20, 59))).toBe("2026-11-01");
		expect(dayIn(ZONE, Date.UTC(2026, 10, 1, 21))).toBe("2026-11-02");
		expect(startOfDay(ZONE, "2026-11-02")).toBe(Date.UTC(2026, 10, 1, 21));
		// Midnight before and after New York moves its clocks on, at 2am.
		expect(startOfDay("America/New_York", "2026-03-08")).toBe(Date.UTC(2026, 2, 8, 5));
		expect(startOfDay("America/New_York", "2026-03-09")).toBe(Date.UTC(2026, 2, 9, 4));
		expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
		expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
	});

	it("starts a day where the clock jumps over its midnight", () => {
		// Chile moves its clocks from midnight to 1am on the first Sunday of September.
		for (const day of ["2026-09-05", "2026-09-06", "2026-09-07"]) {
			const start = startOfDay("America/Santiago", day);
			expect(dayIn("America/Santiago", start)).toBe(day);
			expect(dayIn("America/Santiago", start - 1)).toBe(addDays(day, -1));
		}
	});
});

describe("cycle settings", () => {
	it("starts a team's cycles: the current one and two ahead", async () => {
		const { workspace, admin } = await withTeam();
		const startsOn = addDays(today(), -3);

		expect(await setCycles(admin, { weeks: 2, timeZone: ZONE, startsOn })).toMatchObject({
			type: "ack",
		});

		const snapshot = await workspace.snapshot(owner);
		expect(snapshot.teams[0]?.cycles).toEqual({ weeks: 2, timeZone: ZONE });
		expect(
			(await cyclesOf(workspace)).map(({ number, startsOn, endsOn, completedAt }) => ({
				number,
				startsOn,
				endsOn,
				completedAt,
			})),
		).toEqual([
			{ number: 1, startsOn, endsOn: addDays(startsOn, 13), completedAt: null },
			{
				number: 2,
				startsOn: addDays(startsOn, 14),
				endsOn: addDays(startsOn, 27),
				completedAt: null,
			},
			{
				number: 3,
				startsOn: addDays(startsOn, 28),
				endsOn: addDays(startsOn, 41),
				completedAt: null,
			},
		]);
	});

	it("starts with two upcoming cycles when the first is yet to begin", async () => {
		const { workspace, admin } = await withTeam();
		const startsOn = addDays(today(), 5);
		await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn });
		expect((await cyclesOf(workspace)).map((cycle) => cycle.startsOn)).toEqual([
			startsOn,
			addDays(startsOn, 7),
		]);
	});

	it("is for admins, and refuses days that cannot work", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		expect(await setCycles(member, { weeks: 2, timeZone: ZONE, startsOn: today() })).toMatchObject({
			type: "reject",
			reason: "forbidden",
		});

		// A cycle that would be over already, one too far ahead, and a zone that does not exist.
		expect(
			await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: addDays(today(), -7) }),
		).toMatchObject({ type: "reject", reason: "invalid" });
		expect(
			await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: addDays(today(), 400) }),
		).toMatchObject({ type: "reject", reason: "invalid" });
		expect(
			await setCycles(admin, { weeks: 1, timeZone: "Mars/Olympus", startsOn: today() }),
		).toMatchObject({ type: "reject", reason: "invalid" });
		expect(await cyclesOf(workspace)).toEqual([]);

		// With a cycle running, the next starts after it.
		await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: today() });
		expect(
			await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: addDays(today(), 6) }),
		).toMatchObject({ type: "reject", reason: "invalid" });
	});

	it("dates the upcoming cycles anew, keeping their issues", async () => {
		const { workspace, admin } = await withTeam();
		await setCycles(admin, { weeks: 2, timeZone: ZONE, startsOn: today() });
		const [current, next, after] = await cyclesOf(workspace);
		if (!current || !next || !after) throw new Error("Cycles were not made");
		await createIssue(admin, "planned", { cycleId: next.id });

		// One-week cycles from a week after the current one ends: a pause in between.
		const resume = addDays(current.endsOn, 8);
		await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: resume });

		const cycles = await cyclesOf(workspace);
		expect(
			cycles.map(({ id, number, startsOn, endsOn }) => ({ id, number, startsOn, endsOn })),
		).toEqual([
			{ id: current.id, number: 1, startsOn: current.startsOn, endsOn: current.endsOn },
			{ id: next.id, number: 2, startsOn: resume, endsOn: addDays(resume, 6) },
			{ id: after.id, number: 3, startsOn: addDays(resume, 7), endsOn: addDays(resume, 13) },
		]);
		expect((await issueIn(workspace, "planned"))?.cycleId).toBe(next.id);
	});

	it("ends the current cycle today when cycles are turned off, and drops the rest", async () => {
		const { workspace, admin } = await withTeam();
		await setCycles(admin, { weeks: 2, timeZone: ZONE, startsOn: addDays(today(), -2) });
		const [current, next] = await cyclesOf(workspace);
		if (!current || !next) throw new Error("Cycles were not made");
		await createIssue(admin, "open", { cycleId: current.id });
		await createIssue(admin, "done", { cycleId: current.id, status: "done" });
		await createIssue(admin, "planned", { cycleId: next.id });

		await setCycles(admin, null);

		const snapshot = await workspace.snapshot(owner);
		expect(snapshot.teams[0]?.cycles).toBeNull();
		expect(snapshot.cycles).toEqual([
			expect.objectContaining({ id: current.id, endsOn: today(), completedAt: expect.any(Number) }),
		]);
		const cycleOf = (id: string) => snapshot.issues.find((issue) => issue.id === id)?.cycleId;
		expect([cycleOf("open"), cycleOf("done"), cycleOf("planned")]).toEqual([
			null,
			current.id,
			null,
		]);
		expect(
			snapshot.activities
				.filter((activity) => activity.change.type === "cycle")
				.map(({ issueId, actorId, change }) => ({ issueId, actorId, change })),
		).toEqual([
			{ issueId: "open", actorId: owner.id, change: { type: "cycle", from: current.id, to: null } },
			{ issueId: "planned", actorId: owner.id, change: { type: "cycle", from: next.id, to: null } },
		]);

		// Turned on again, the numbers carry on from the cycle that ran.
		await setCycles(admin, { weeks: 2, timeZone: ZONE, startsOn: addDays(today(), 1) });
		expect((await cyclesOf(workspace)).map((cycle) => cycle.number)).toEqual([1, 2, 3]);
	});
});

describe("issues in cycles", () => {
	it("join a cycle of their own team that has not completed, with history", async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({ name: "team.create", args: { id: "team-ops", key: "OPS", name: "Ops" } });
		await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: today() });
		await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: today() }, "team-ops");
		const [current] = await cyclesOf(workspace);
		const [theirs] = await cyclesOf(workspace, "team-ops");
		if (!current || !theirs) throw new Error("Cycles were not made");
		await createIssue(admin, "i-1");

		const update = (cycleId: string | null) =>
			admin.mutate({
				name: "issue.update",
				args: { id: "i-1", baseVersion: 0, patch: { cycleId } },
			});
		expect(await update(theirs.id)).toMatchObject({ type: "reject", reason: "invalid" });
		expect(await update("no-such-cycle")).toMatchObject({ type: "reject", reason: "not_found" });
		expect(
			await admin.mutate({
				name: "issue.create",
				args: {
					id: "i-2",
					teamId: "team-ops",
					title: "Wrong team",
					sortOrder: "a0",
					cycleId: current.id,
				},
			}),
		).toMatchObject({ type: "reject", reason: "invalid" });

		expect(await update(current.id)).toMatchObject({ type: "ack" });
		const snapshot = await workspace.snapshot(owner);
		expect(snapshot.issues.find((issue) => issue.id === "i-1")?.cycleId).toBe(current.id);
		expect(snapshot.activities.map((activity) => activity.change)).toContainEqual({
			type: "cycle",
			from: null,
			to: current.id,
		});

		// Once the cycle completes, it takes no more issues, though the ones in it may stay.
		await advanceAt(workspace, startOfDay(ZONE, addDays(current.endsOn, 1)));
		await createIssue(admin, "i-3");
		expect(
			await admin.mutate({
				name: "issue.update",
				args: { id: "i-3", baseVersion: 0, patch: { cycleId: current.id } },
			}),
		).toMatchObject({ type: "reject", reason: "invalid" });
	});

	it("can be named, and named back to their number", async () => {
		const { workspace, admin } = await withTeam();
		await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: today() });
		const [current] = await cyclesOf(workspace);
		if (!current) throw new Error("No cycle");
		const member = await TestClient.live(workspace, alice);

		await member.apply({
			name: "cycle.update",
			args: { id: current.id, patch: { name: "Launch" } },
		});
		expect((await cyclesOf(workspace))[0]?.name).toBe("Launch");
		await member.apply({ name: "cycle.update", args: { id: current.id, patch: { name: null } } });
		expect((await cyclesOf(workspace))[0]?.name).toBeNull();
	});
});

describe("the cycle step", () => {
	it("completes a cycle once its last day is over, moving unfinished issues on", async () => {
		const { workspace, admin } = await withTeam();
		await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: today() });
		const [current, next] = await cyclesOf(workspace);
		if (!current || !next) throw new Error("Cycles were not made");
		await createIssue(admin, "open", { cycleId: current.id });
		await createIssue(admin, "done", { cycleId: current.id, status: "done" });
		const midnight = startOfDay(ZONE, addDays(current.endsOn, 1));

		// Not a moment early.
		await advanceAt(workspace, midnight - 1);
		expect((await cyclesOf(workspace))[0]?.completedAt).toBeNull();

		await advanceAt(workspace, midnight);
		const snapshot = await workspace.snapshot(owner);
		const cycles = snapshot.cycles;
		expect(cycles[0]).toMatchObject({
			id: current.id,
			completedAt: midnight,
			endsOn: current.endsOn,
		});
		// The next cycle is now the current one, so another is made to keep two ahead.
		expect(cycles.map((cycle) => cycle.number)).toEqual([1, 2, 3, 4]);
		const cycleOf = (id: string) => snapshot.issues.find((issue) => issue.id === id)?.cycleId;
		expect([cycleOf("open"), cycleOf("done")]).toEqual([next.id, current.id]);
		expect(snapshot.activities.at(-1)).toMatchObject({
			issueId: "open",
			actorId: SYSTEM_ACTOR_ID,
			change: { type: "cycle", from: current.id, to: next.id },
		});

		// Running again changes nothing.
		const version = snapshot.version;
		await advanceAt(workspace, midnight + 1000);
		expect((await workspace.snapshot(owner)).version).toBe(version);
	});

	it("skips the cycles a workspace slept through, keeping the rhythm", async () => {
		const { workspace, admin } = await withTeam();
		await setCycles(admin, { weeks: 1, timeZone: ZONE, startsOn: today() });
		const [current] = await cyclesOf(workspace);
		if (!current) throw new Error("No cycle");
		await createIssue(admin, "open");
		await admin.apply({
			name: "issue.update",
			args: { id: "open", baseVersion: 0, patch: { cycleId: current.id } },
		});

		// Woken five weeks later, in the middle of a week-long cycle.
		const later = addDays(current.startsOn, 5 * 7 + 3);
		await advanceAt(workspace, startOfDay(ZONE, later));

		const cycles = await cyclesOf(workspace);
		const running = cycles.find((cycle) => cycle.startsOn <= later && later <= cycle.endsOn);
		expect(running?.startsOn).toBe(addDays(current.startsOn, 5 * 7));
		expect(running?.completedAt).toBeNull();
		expect(cycles.filter((cycle) => cycle.startsOn > later)).toHaveLength(2);
		expect(cycles.filter((cycle) => cycle.completedAt !== null).length).toBeGreaterThan(0);
		// The issue ends up in the cycle that is running, in one history entry.
		expect((await issueIn(workspace, "open"))?.cycleId).toBe(running?.id);
		const snapshot = await workspace.snapshot(owner);
		expect(
			snapshot.activities.filter(
				(activity) => activity.issueId === "open" && activity.change.type === "cycle",
			),
		).toEqual([
			expect.objectContaining({
				actorId: owner.id,
				change: { type: "cycle", from: null, to: current.id },
			}),
			expect.objectContaining({
				actorId: SYSTEM_ACTOR_ID,
				change: { type: "cycle", from: current.id, to: running?.id },
			}),
		]);
	});

	it("tells the alarm when the next cycle starts or ends", async () => {
		const { workspace, admin } = await withTeam();
		const startsOn = addDays(today(), 3);
		await setCycles(admin, { weeks: 2, timeZone: ZONE, startsOn });
		await runInDurableObject(workspace, (_, state) => {
			const db = drizzle(state.storage, { schema });
			expect(nextCycleChange(db, Date.now())).toBe(startOfDay(ZONE, startsOn));
			// After it starts, the next change is the day after it ends.
			const started = startOfDay(ZONE, startsOn) + 1000;
			state.storage.transactionSync(() => advanceCycles(db, started));
			expect(nextCycleChange(db, started)).toBe(startOfDay(ZONE, addDays(startsOn, 14)));
		});
	});

	it("wakes the alarm at the next cycle boundary", async () => {
		const { workspace, admin } = await withTeam();
		// A zone whose next midnight comes before the alarm's other work, which is hours away.
		const zone = soonestMidnight();
		const day = today(zone);
		await setCycles(admin, { weeks: 1, timeZone: zone, startsOn: addDays(day, -6) });

		// The update wakes the alarm at once, and that run, which comes on its own, sets it for the
		// boundary. Running the alarm here as well would race it, and the two can leave none set.
		await vi.waitFor(
			() =>
				runInDurableObject(workspace, async (_, state) => {
					expect(await state.storage.getAlarm()).toBe(startOfDay(zone, addDays(day, 1)));
				}),
			{ timeout: 5000, interval: 20 },
		);
	});
});

/** Of the whole-hour zones, the one whose next midnight is soonest, but not within a minute. */
function soonestMidnight(): string {
	let best = { zone: "Etc/UTC", at: Number.POSITIVE_INFINITY };
	for (let offset = -12; offset <= 14; offset += 1) {
		// Etc zones have the sign the other way round: Etc/GMT-3 is three hours ahead of UTC.
		const zone = offset === 0 ? "Etc/UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
		const at = startOfDay(zone, addDays(dayIn(zone, Date.now()), 1));
		if (at - Date.now() > 60_000 && at < best.at) best = { zone, at };
	}
	return best.zone;
}
