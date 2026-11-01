import { runInDurableObject } from "cloudflare:test";
import {
	AUTOMATION_MONTH_MS,
	type MutationInput,
	SYSTEM_ACTOR_ID,
} from "@gateweave/track-protocol";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";
import type { MemberProfile } from "../src";
import {
	AUTOMATION_BATCH,
	AUTOMATION_INTERVAL_MS,
	nextAutomationsAt,
	runAutomations,
} from "../src/automations";
import * as schema from "../src/db/schema";
import { freshWorkspace, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const TEAM_ID = "team-1";
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
	const workspace = freshWorkspace();
	for (const member of [owner, alice]) await workspace.syncMember(member);
	let n = 0;
	const as = async (member: MemberProfile, mutation: MutationInput) =>
		workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
	const ok = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await as(member, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await ok(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	// Alice files the issues, so she follows them and would hear of anyone's change to them.
	const issue = (id: string, status: string) =>
		ok(alice, {
			name: "issue.create",
			args: { id, teamId: TEAM_ID, title: `Issue ${id}`, status, sortOrder: "a0" },
		} as MutationInput);
	// The alarm the change wakes would run the automations on the real clock. The tests run them
	// at times of their own instead, so they turn it off, and age issues after it, where they can.
	const automate = async (patch: {
		archiveAfterMonths?: number | null;
		closeAfterMonths?: number | null;
	}) => {
		await ok(owner, { name: "team.update", args: { id: TEAM_ID, patch } });
		await runInDurableObject(workspace, (_, state) => state.storage.deleteAlarm());
	};

	// Each run comes two days after the last, so it is always due.
	let clock = Date.now();
	const run = () => {
		clock += 2 * DAY;
		const at = clock;
		return runInDurableObject(workspace, (_, state) =>
			state.storage.transactionSync(() => runAutomations(drizzle(state.storage, { schema }), at)),
		);
	};
	/** Makes the issues look last touched this many months (and a day) before the next run. */
	const age = (months: number, ...ids: string[]) =>
		runInDurableObject(workspace, (_, state) => {
			const updatedAt = clock + 2 * DAY - months * AUTOMATION_MONTH_MS - DAY;
			const db = drizzle(state.storage, { schema });
			// A Durable Object binds at most 100 values in a statement.
			for (let i = 0; i < ids.length; i += 50) {
				const chunk = ids.slice(i, i + 50);
				db.update(schema.issues).set({ updatedAt }).where(inArray(schema.issues.id, chunk)).run();
			}
		});
	const issues = async () => {
		const snapshot = await workspace.snapshot(owner);
		return new Map(snapshot.issues.map((each) => [each.id, each]));
	};
	return { workspace, as, issue, automate, run, age, issues, now: () => clock };
}

async function nextAt(workspace: Workspace) {
	return runInDurableObject(workspace, (_, state) =>
		nextAutomationsAt(drizzle(state.storage, { schema })),
	);
}

async function historyOf(workspace: Workspace, issueId: string) {
	const snapshot = await workspace.snapshot(owner);
	return snapshot.activities.filter((activity) => activity.issueId === issueId);
}

describe("team automations", () => {
	it("close issues nobody started that sat untouched past the team's wait, as Track", async () => {
		const { workspace, issue, automate, run, age, issues } = await setup();
		await issue("backlog-old", "backlog");
		await issue("todo-old", "todo");
		await issue("started-old", "in_progress");
		await issue("backlog-recent", "backlog");
		expect(await nextAt(workspace)).toBeNull();
		await automate({ closeAfterMonths: 3 });
		await age(4, "backlog-old", "todo-old", "started-old");
		await age(2, "backlog-recent");
		await run();
		const after = await issues();
		expect(after.get("backlog-old")).toMatchObject({ status: "canceled", archivedAt: null });
		expect(after.get("todo-old")).toMatchObject({ status: "canceled", archivedAt: null });
		// Started work is not abandoned, however long it takes, and two months is not three.
		expect(after.get("started-old")?.status).toBe("in_progress");
		expect(after.get("backlog-recent")?.status).toBe("backlog");

		expect(await historyOf(workspace, "backlog-old")).toContainEqual(
			expect.objectContaining({
				actorId: SYSTEM_ACTOR_ID,
				change: { type: "status", from: "backlog", to: "canceled" },
			}),
		);
		// The team's rule closed it, not a person: the people following it hear nothing.
		const inbox = (await workspace.snapshot(alice)).inbox;
		expect(inbox.find((item) => item.issueId === "backlog-old")).toBeUndefined();
	});

	it("leave requests in intake alone, however long they wait", async () => {
		const { as, automate, run, age, issues } = await setup();
		await as(alice, {
			name: "issue.create",
			args: { id: "request", teamId: TEAM_ID, title: "Request", sortOrder: "a0", intake: true },
		});
		await automate({ closeAfterMonths: 3, archiveAfterMonths: 3 });
		await age(4, "request");
		await run();
		// A request is never closed, so nothing here would archive it either.
		expect((await issues()).get("request")).toMatchObject({ status: "backlog", intake: true });
	});

	it("archive closed issues untouched past the team's wait, and later what they closed", async () => {
		const { workspace, issue, automate, run, age, issues, now } = await setup();
		await issue("done-old", "done");
		await issue("canceled-old", "canceled");
		await issue("done-recent", "done");
		await issue("backlog-old", "backlog");
		await automate({ archiveAfterMonths: 6 });
		await age(7, "done-old", "canceled-old", "backlog-old");
		await age(5, "done-recent");
		await run();
		let after = await issues();
		expect(after.get("done-old")?.archivedAt).toBe(now());
		expect(after.get("canceled-old")?.archivedAt).toBe(now());
		expect(after.get("done-recent")?.archivedAt).toBeNull();
		// Without a rule to close them, open issues stay as they are.
		expect(after.get("backlog-old")).toMatchObject({ status: "backlog", archivedAt: null });
		expect(await historyOf(workspace, "done-old")).toContainEqual(
			expect.objectContaining({
				actorId: SYSTEM_ACTOR_ID,
				change: { type: "archived", archived: true },
			}),
		);

		// Closing an issue touches it, so it is archived only once the wait has passed again.
		// (The alarm this wakes may close it first, on the real clock; it ends the same either way.)
		await automate({ closeAfterMonths: 6 });
		await run();
		after = await issues();
		expect(after.get("backlog-old")).toMatchObject({ status: "canceled", archivedAt: null });
		await age(7, "backlog-old");
		await run();
		expect((await issues()).get("backlog-old")?.archivedAt).toBe(now());
	});

	it("leave issues alone once turned off, or when the team has no canceled status", async () => {
		const { workspace, as, issue, automate, run, age, issues } = await setup();
		await issue("backlog-old", "backlog");
		await automate({ closeAfterMonths: 3, archiveAfterMonths: 3 });
		await automate({ closeAfterMonths: null, archiveAfterMonths: null });
		await age(4, "backlog-old");
		expect(await nextAt(workspace)).toBeNull();
		await run();
		expect((await issues()).get("backlog-old")?.status).toBe("backlog");

		// Closing them takes a canceled status to close them to.
		const removed = await as(owner, {
			name: "status.delete",
			args: { teamId: TEAM_ID, key: "canceled", moveTo: "done" },
		});
		expect(removed.ok).toBe(true);
		await automate({ closeAfterMonths: 3 });
		await age(4, "backlog-old");
		await run();
		expect((await issues()).get("backlog-old")?.status).toBe("backlog");
	});

	it("work through a large backlog a batch at a time, then wait a day", async () => {
		const { workspace, issue, automate, run, age, issues, now } = await setup();
		const ids = Array.from({ length: AUTOMATION_BATCH + 5 }, (_, i) => `issue-${i}`);
		for (const id of ids) await issue(id, "backlog");
		await automate({ closeAfterMonths: 3 });
		await age(4, ...ids);
		const closed = async () => {
			const after = await issues();
			return ids.filter((id) => after.get(id)?.status === "canceled").length;
		};

		await run();
		expect(await closed()).toBe(AUTOMATION_BATCH);
		expect(await nextAt(workspace)).toBe(now() + 60_000);

		await run();
		expect(await closed()).toBe(ids.length);
		expect(await nextAt(workspace)).toBe(now() + AUTOMATION_INTERVAL_MS);
	});

	it("are set by admins, a month to two years at a time", async () => {
		const { as } = await setup();
		const update = (member: MemberProfile, patch: Record<string, unknown>) =>
			as(member, { name: "team.update", args: { id: TEAM_ID, patch } } as MutationInput);
		expect(await update(alice, { closeAfterMonths: 3 })).toMatchObject({ ok: false });
		expect(await update(owner, { closeAfterMonths: 0 })).toMatchObject({ ok: false });
		expect(await update(owner, { archiveAfterMonths: 25 })).toMatchObject({ ok: false });
		expect(await update(owner, { archiveAfterMonths: 1.5 })).toMatchObject({ ok: false });
		expect(await update(owner, { archiveAfterMonths: 24 })).toMatchObject({ ok: true });
	});
});
