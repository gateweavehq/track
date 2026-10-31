import { runInDurableObject } from "cloudflare:test";
import {
	atHour,
	dayIn,
	type MutationInput,
	privateId,
	SYSTEM_ACTOR_ID,
} from "@gateweave/track-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, vi } from "vitest";
import type { MemberProfile } from "../src";
import * as schema from "../src/db/schema";
import { nextReminderAt, REMINDER_HOUR, remindDue } from "../src/reminders";
import { freshWorkspace, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };
const TEAM_ID = "team-1";
// Far enough ahead that the alarm, which runs on the real clock, never reminds of it first.
const DUE = "2030-03-04";

async function setup() {
	const workspace = freshWorkspace();
	for (const member of [owner, alice, triage]) await workspace.syncMember(member);
	let n = 0;
	const as = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await as(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	// Alice assigns her issues to herself, so being assigned puts nothing in her inbox.
	const issue = (id: string, fields: Record<string, unknown> = {}) =>
		as(alice, {
			name: "issue.create",
			args: {
				id,
				teamId: TEAM_ID,
				title: `Issue ${id}`,
				sortOrder: "a0",
				assigneeId: alice.id,
				dueDate: DUE,
				...fields,
			},
		} as MutationInput);
	const update = async (id: string, patch: Record<string, unknown>) => {
		const row = (await workspace.snapshot(owner)).issues.find((each) => each.id === id);
		await as(owner, {
			name: "issue.update",
			args: { id, baseVersion: row?.version ?? 0, patch },
		} as MutationInput);
	};
	return { workspace, as, issue, update };
}

async function remindAt(workspace: Workspace, at: number) {
	await runInDurableObject(workspace, (_, state) => {
		state.storage.transactionSync(() => remindDue(drizzle(state.storage, { schema }), at));
	});
}

async function nextAt(workspace: Workspace, now: number) {
	return runInDurableObject(workspace, (_, state) =>
		nextReminderAt(drizzle(state.storage, { schema }), now),
	);
}

async function itemOf(workspace: Workspace, member: MemberProfile, issueId: string) {
	return (await workspace.snapshot(member)).inbox.find((item) => item.issueId === issueId);
}

const utc = (day: string, hour: number, minute = 0) =>
	Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);

/** A fixed-offset time zone where the clock now reads about `hour` o'clock. */
function zoneAtHour(hour: number): string {
	let offset = hour - new Date().getUTCHours();
	if (offset > 14) offset -= 24;
	if (offset < -12) offset += 24;
	// Etc/GMT zones count the other way: Etc/GMT-3 is three hours ahead of UTC.
	return offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

describe("due-date reminders", () => {
	it("remind the assignee on the morning of the due date, once", async () => {
		const { workspace, issue } = await setup();
		await issue("issue-1");
		const morning = utc(DUE, REMINDER_HOUR);
		expect(await nextAt(workspace, utc("2030-03-01", 12))).toBe(morning);

		await remindAt(workspace, morning - 60_000);
		expect(await itemOf(workspace, alice, "issue-1")).toBeUndefined();

		await remindAt(workspace, morning);
		expect(await itemOf(workspace, alice, "issue-1")).toMatchObject({
			event: { type: "due", on: DUE },
			actorId: SYSTEM_ACTOR_ID,
			unread: 1,
		});
		await remindAt(workspace, morning + 60 * 60_000);
		expect(await itemOf(workspace, alice, "issue-1")).toMatchObject({ unread: 1 });
		expect(await nextAt(workspace, morning + 60 * 60_000)).toBeNull();

		// Reminders are emailed until people choose otherwise.
		const emailAt = await runInDurableObject(workspace, (_, state) => {
			const db = drizzle(state.storage, { schema });
			return db
				.select({ emailAt: schema.inboxItems.emailAt })
				.from(schema.inboxItems)
				.where(eq(schema.inboxItems.id, privateId("issue-1", alice.id)))
				.get()?.emailAt;
		});
		expect(emailAt).not.toBeNull();
	});

	it("follow the time zone of a team with cycles", async () => {
		const { workspace, as, issue } = await setup();
		const timeZone = "Asia/Tokyo";
		await as(owner, {
			name: "team.update",
			args: {
				id: TEAM_ID,
				patch: { cycles: { weeks: 2, timeZone, startsOn: dayIn(timeZone, Date.now()) } },
			},
		});
		await issue("issue-1");
		// Nine in the morning in Tokyo is midnight in UTC.
		expect(await nextAt(workspace, utc("2030-03-01", 12))).toBe(utc(DUE, 0));
		expect(atHour(timeZone, DUE, REMINDER_HOUR)).toBe(utc(DUE, 0));

		await remindAt(workspace, utc("2030-03-03", 23, 59));
		expect(await itemOf(workspace, alice, "issue-1")).toBeUndefined();
		await remindAt(workspace, utc(DUE, 0));
		expect(await itemOf(workspace, alice, "issue-1")).toMatchObject({ event: { type: "due" } });
	});

	it("remind again on a new due date, and never of a day gone by or of a closed issue", async () => {
		const { workspace, issue, update } = await setup();
		await issue("moved");
		await issue("missed");
		await issue("done", { status: "done" });
		await issue("unassigned", { assigneeId: null });
		await issue("agent", { assigneeId: triage.id });

		await remindAt(workspace, utc(DUE, REMINDER_HOUR));
		expect(await itemOf(workspace, alice, "moved")).toMatchObject({ unread: 1 });
		await update("moved", { dueDate: "2030-03-06" });
		await remindAt(workspace, utc("2030-03-06", REMINDER_HOUR));
		expect(await itemOf(workspace, alice, "moved")).toMatchObject({
			event: { type: "due", on: "2030-03-06" },
			unread: 2,
		});

		// A day that went by without its reminder stays without one.
		await update("missed", { dueDate: "2030-03-05" });
		await remindAt(workspace, utc("2030-03-06", REMINDER_HOUR));
		expect(await itemOf(workspace, alice, "missed")).toMatchObject({ unread: 1 });
		expect((await itemOf(workspace, alice, "missed"))?.event).toEqual({ type: "due", on: DUE });

		for (const id of ["done", "unassigned"]) {
			expect(await itemOf(workspace, alice, id)).toBeUndefined();
		}
		expect((await workspace.snapshot(triage)).inbox).toEqual([]);
		expect(await nextAt(workspace, utc("2030-03-06", REMINDER_HOUR))).toBeNull();
	});

	it("are planned and sent by the alarm", async () => {
		const { workspace, as, issue } = await setup();
		// Email would have the alarm come back sooner, for the digest.
		await workspace.updateNotificationSettings(alice, { due: "inbox" });
		const withCycles = async (id: string, timeZone: string) => {
			await as(owner, { name: "team.create", args: { id, key: id.toUpperCase(), name: id } });
			await as(owner, {
				name: "team.update",
				args: {
					id,
					patch: { cycles: { weeks: 1, timeZone, startsOn: dayIn(timeZone, Date.now()) } },
				},
			});
		};

		// Past the reminder hour in the team's time zone, an issue due today reminds at once.
		const late = zoneAtHour(15);
		await withCycles("late", late);
		await issue("today", { teamId: "late", dueDate: dayIn(late, Date.now()) });
		await vi.waitFor(async () => {
			expect(await itemOf(workspace, alice, "today")).toMatchObject({ event: { type: "due" } });
		});

		// Before it, the alarm waits for the reminder hour.
		const early = zoneAtHour(5);
		await withCycles("early", early);
		const today = dayIn(early, Date.now());
		await issue("later", { teamId: "early", dueDate: today });
		const morning = atHour(early, today, REMINDER_HOUR);
		await vi.waitFor(async () => {
			const alarm = await runInDurableObject(workspace, (_, state) => state.storage.getAlarm());
			expect(alarm).toBe(morning);
		});
		expect(await itemOf(workspace, alice, "later")).toBeUndefined();
	});
});
