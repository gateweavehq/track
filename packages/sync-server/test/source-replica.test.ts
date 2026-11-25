import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { Signal, Source } from "@gateweave/track-protocol";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { expect, it } from "vitest";
import migrations from "../drizzle/migrations";
import * as schema from "../src/db/schema";
import { freshWorkspace } from "./client";

const owner = {
	id: "admin",
	role: "owner",
	name: "Owner",
	email: "owner@example.org",
	image: null,
} as const;
async function withTeam() {
	const workspace = freshWorkspace();
	await workspace.syncMember(owner);
	expect(
		await workspace.mutate(owner, "browser", "team", {
			name: "team.create",
			args: { id: "eng", key: "ENG", name: "Engineering" },
		}),
	).toMatchObject({ ok: true });
	return workspace;
}

const source: Source = {
	id: "guard1",
	name: "Guard",
	product: "guard",
	teamId: "eng",
	assigneeId: null,
	lowestSeverity: "high",
	closeWhenCleared: false,
	linkOrigins: ["https://guard.example.org"],
	paused: false,
	lastHeardAt: 100,
};
const signal: Signal = {
	id: "first",
	sourceId: source.id,
	kind: "alert",
	key: "main",
	type: null,
	subject: null,
	severity: "high",
	state: "open",
	url: null,
	issueId: null,
	reopens: 0,
	firstAt: 100,
	changedAt: 100,
	progress: null,
	startedAt: null,
	endedAt: null,
	executor: null,
	agentName: null,
	waitReason: null,
	waitDetail: null,
	lastContactAt: null,
};
async function populated() {
	const workspace = await withTeam();
	await runInDurableObject(workspace, (_, state) => {
		const db = drizzle(state.storage, { schema });
		db.insert(schema.sources)
			.values({
				...source,
				callTimes: [100],
				lastRefusedAt: 99,
				usage: [{ at: 100, bytes: 40, filed: false, assigned: false, reopened: null }],
			})
			.run();
		db.insert(schema.signals)
			.values({ ...signal, lastSentAt: 99 })
			.run();
	});
	return workspace.snapshot(owner);
}

it("R13: the replica contains exactly the signal fields, without its event text or ordering stamp", async () => {
	expect((await populated()).signals).toEqual([signal]);
});
it("R32: the replica contains the source configuration and last-heard time without private accounting", async () => {
	expect((await populated()).sources).toEqual([source]);
});
it("R50: a workspace with no source has no signal, source actor or inbox item", async () => {
	const workspace = await withTeam();
	const snapshot = await workspace.snapshot(owner);
	expect(snapshot.sources).toEqual([]);
	expect(snapshot.signals).toEqual([]);
	expect(snapshot.members.map(({ id }) => id)).toEqual([owner.id]);
	expect(snapshot.inbox).toEqual([]);
	expect(snapshot.activities).toEqual([]);
});
it("R52: sources and scoped work migrations preserve a populated workspace", async () => {
	const workspace = await withTeam();
	expect(
		await workspace.mutate(owner, "browser", "issue", {
			name: "issue.create",
			args: { id: "work", teamId: "eng", title: "Existing work", sortOrder: "a0" },
		}),
	).toMatchObject({ ok: true });
	const before = await workspace.snapshot(owner);
	const entry = migrations.journal.entries.find((row) => row.tag === "0033_sources_signals");
	if (!entry) throw new Error("Missing sources migration");
	await runInDurableObject(workspace, async (_, state) => {
		const db = drizzle(state.storage, { schema });
		db.run(sql`drop table work_run_attempts`);
		db.run(sql`drop table work_run_requests`);
		db.run(sql`drop table signals`);
		db.run(sql`drop table sources`);
		db.run(sql`delete from __drizzle_migrations where created_at >= ${entry.when}`);
		const tables = () =>
			db.all<{ name: string; sql: string }>(
				sql`select name, sql from sqlite_master where type='table' order by name`,
			);
		const previous = tables();
		await migrate(db, migrations);
		const current = tables();
		const added = ["sources", "signals", "work_run_attempts", "work_run_requests"];
		expect(current.filter(({ name }) => !added.includes(name))).toEqual(previous);
		expect(
			current
				.filter(({ name }) => added.includes(name))
				.map(({ name }) => name)
				.sort(),
		).toEqual(added.sort());
	});
	expect(await workspace.snapshot(owner)).toEqual(before);
});

it("R50: the pruning alarm takes no version in a workspace without sources", async () => {
	const ws = await withTeam();
	const before = await ws.snapshot(owner);
	await runInDurableObject(ws, (_, state) => state.storage.setAlarm(Date.now()));
	expect(await runDurableObjectAlarm(ws)).toBe(true);
	expect(await ws.snapshot(owner)).toEqual(before);
});
