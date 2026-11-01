import { runInDurableObject } from "cloudflare:test";
import {
	type MutationInput,
	nextRepeatDay,
	SYSTEM_ACTOR_ID,
	startOfDay,
	type TemplateRepeat,
} from "@gateweave/track-protocol";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";
import type { MemberProfile } from "../src";
import * as schema from "../src/db/schema";
import { nextRecurringAt, RECURRING_BATCH, runRecurring } from "../src/recurring";
import { freshWorkspace, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const bob: MemberProfile = { ...owner, id: "user-bob", name: "Bob", role: "member" };
const TEAM_ID = "team-1";
// Schedules start years ahead, so the alarm a change wakes, on the real clock, finds nothing due.
const MONDAY = "2030-01-07";

async function setup() {
	const workspace = freshWorkspace();
	for (const member of [owner, alice, bob]) await workspace.syncMember(member);
	let n = 0;
	const as = (member: MemberProfile, mutation: MutationInput) =>
		workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
	const ok = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await as(member, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await ok(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	await ok(owner, { name: "label.create", args: { id: "chore", name: "Chore", color: "#0090ff" } });
	const repeating = (id: string, repeat: TemplateRepeat, fields: Record<string, unknown> = {}) =>
		ok(alice, {
			name: "template.create",
			args: { id, teamId: TEAM_ID, name: id, title: `Issue from ${id}`, repeat, ...fields },
		} as MutationInput);
	const run = (at: number) =>
		runInDurableObject(workspace, (_, state) =>
			state.storage.transactionSync(() => runRecurring(drizzle(state.storage, { schema }), at)),
		);
	const issues = async () => (await workspace.snapshot(owner)).issues;
	const template = async (id: string) =>
		(await workspace.snapshot(owner)).templates.find((each) => each.id === id);
	return { workspace, as, ok, repeating, run, issues, template };
}

const nextAt = (workspace: Workspace) =>
	runInDurableObject(workspace, (_, state) => nextRecurringAt(drizzle(state.storage, { schema })));

const weekly = (startsOn: string, timeZone = "UTC"): TemplateRepeat => ({
	every: 1,
	unit: "week",
	startsOn,
	timeZone,
});

describe("recurring issues", () => {
	it("are made at the start of each day the schedule falls on, as Track, and reach the assignee", async () => {
		const { workspace, repeating, run, issues, template } = await setup();
		await repeating("weekly-report", weekly(MONDAY, "Europe/Istanbul"), {
			title: "Weekly report ",
			description: "What shipped, what is next.",
			priority: 2,
			labelIds: ["chore"],
			assigneeId: bob.id,
		});
		expect(await template("weekly-report")).toMatchObject({
			repeat: weekly(MONDAY, "Europe/Istanbul"),
			nextOn: MONDAY,
		});
		// Midnight in Istanbul is 21:00 the day before in UTC.
		const midnight = Date.UTC(2030, 0, 6, 21);
		expect(startOfDay("Europe/Istanbul", MONDAY)).toBe(midnight);
		expect(await nextAt(workspace)).toBe(midnight);

		await run(midnight - 1);
		expect(await issues()).toEqual([]);

		await run(midnight);
		expect(await issues()).toEqual([
			expect.objectContaining({
				number: 1,
				title: "Weekly report",
				description: "What shipped, what is next.",
				// The team's first status that is not started, ready to pick up.
				status: "todo",
				priority: 2,
				labelIds: ["chore"],
				assigneeId: bob.id,
				creatorId: SYSTEM_ACTOR_ID,
				createdAt: midnight,
			}),
		]);
		expect((await template("weekly-report"))?.nextOn).toBe("2030-01-14");
		expect(await nextAt(workspace)).toBe(Date.UTC(2030, 0, 13, 21));

		// Bob hears of it as of any issue assigned to him; Track subscribes to nothing.
		const inbox = (await workspace.snapshot(bob)).inbox;
		expect(inbox).toEqual([
			expect.objectContaining({ actorId: SYSTEM_ACTOR_ID, event: { type: "assigned" } }),
		]);

		// Later the same day there is nothing more to make.
		await run(midnight + 12 * 60 * 60 * 1000);
		expect(await issues()).toHaveLength(1);
	});

	it("make one issue for the days the alarm missed, and plan the next from today", async () => {
		const { repeating, run, issues, template } = await setup();
		await repeating("daily", { every: 1, unit: "day", startsOn: MONDAY, timeZone: "UTC" });
		await run(Date.UTC(2030, 0, 10, 5));
		expect(await issues()).toHaveLength(1);
		expect((await template("daily"))?.nextOn).toBe("2030-01-11");
	});

	it("make no second issue on a day a changed schedule falls on, and stop when turned off", async () => {
		const { workspace, ok, repeating, run, issues, template } = await setup();
		const daily: TemplateRepeat = { every: 1, unit: "day", startsOn: MONDAY, timeZone: "UTC" };
		await repeating("daily", daily);
		await run(Date.UTC(2030, 0, 7, 1));
		expect(await issues()).toHaveLength(1);

		// Changing anything else leaves the schedule's next day alone.
		await ok(alice, { name: "template.update", args: { id: "daily", patch: { name: "Daily" } } });
		expect((await template("daily"))?.nextOn).toBe("2030-01-08");
		// The new schedule also falls on Monday, whose issue exists, so it begins after it.
		await ok(alice, {
			name: "template.update",
			args: { id: "daily", patch: { repeat: weekly(MONDAY) } },
		});
		expect((await template("daily"))?.nextOn).toBe("2030-01-14");

		await ok(alice, { name: "template.update", args: { id: "daily", patch: { repeat: null } } });
		expect(await template("daily")).toMatchObject({ repeat: null, nextOn: null });
		expect(await nextAt(workspace)).toBeNull();
		await run(Date.UTC(2030, 1, 1));
		expect(await issues()).toHaveLength(1);
	});

	it("need a title, and leave out an assignee who has left", async () => {
		const { workspace, as, ok, repeating, run, issues } = await setup();
		for (const title of ["", "  "]) {
			expect(
				await as(alice, {
					name: "template.create",
					args: {
						id: "untitled",
						teamId: TEAM_ID,
						name: "Untitled",
						title,
						repeat: weekly(MONDAY),
					},
				}),
			).toMatchObject({ reason: "invalid" });
		}
		await repeating("weekly", weekly(MONDAY), { assigneeId: bob.id });
		expect(
			await as(alice, { name: "template.update", args: { id: "weekly", patch: { title: "" } } }),
		).toMatchObject({ reason: "invalid" });
		// Without a schedule, a title can be left for whoever uses the template.
		await ok(alice, {
			name: "template.create",
			args: { id: "blank", teamId: TEAM_ID, name: "Blank", title: "" },
		});
		expect(
			await as(alice, {
				name: "template.update",
				args: { id: "blank", patch: { repeat: weekly(MONDAY) } },
			}),
		).toMatchObject({ reason: "invalid" });

		await workspace.removeMember(bob.id);
		await run(Date.UTC(2030, 0, 7));
		expect(await issues()).toEqual([expect.objectContaining({ assigneeId: null })]);
	});

	it("work through more due schedules than a batch, then wait for the next day", async () => {
		const { ok, repeating, run, issues } = await setup();
		await ok(owner, { name: "team.create", args: { id: "team-2", key: "OPS", name: "Ops" } });
		const count = RECURRING_BATCH + 5;
		for (let i = 0; i < count; i++) {
			await repeating(`t-${i}`, weekly(MONDAY), i % 2 === 0 ? { teamId: "team-2" } : {});
		}
		await run(Date.UTC(2030, 0, 7, 1));
		expect(await issues()).toHaveLength(RECURRING_BATCH);
		await run(Date.UTC(2030, 0, 7, 1, 1));
		expect(await issues()).toHaveLength(count);
	});
});

describe("nextRepeatDay", () => {
	it("counts days and weeks from the first day", () => {
		const every3 = { every: 3, unit: "day" as const, startsOn: "2026-01-01" };
		expect(nextRepeatDay(every3, "2025-12-01")).toBe("2026-01-01");
		expect(nextRepeatDay(every3, "2026-01-02")).toBe("2026-01-04");
		expect(nextRepeatDay(every3, "2026-01-04")).toBe("2026-01-04");
		const fortnightly = { every: 2, unit: "week" as const, startsOn: "2026-11-02" };
		expect(nextRepeatDay(fortnightly, "2026-11-03")).toBe("2026-11-16");
		expect(nextRepeatDay(fortnightly, "2027-03-01")).toBe("2027-03-08");
	});

	it("keeps a month's day, or takes the month's last when it is shorter", () => {
		const monthly = { every: 1, unit: "month" as const, startsOn: "2026-01-31" };
		expect(nextRepeatDay(monthly, "2026-02-01")).toBe("2026-02-28");
		expect(nextRepeatDay(monthly, "2026-03-01")).toBe("2026-03-31");
		expect(nextRepeatDay(monthly, "2028-02-01")).toBe("2028-02-29");
		const quarterly = { every: 3, unit: "month" as const, startsOn: "2026-11-30" };
		expect(nextRepeatDay(quarterly, "2027-01-01")).toBe("2027-02-28");
		expect(nextRepeatDay(quarterly, "2027-03-01")).toBe("2027-05-30");
		expect(nextRepeatDay(quarterly, "2027-12-25")).toBe("2028-02-29");
	});
});
