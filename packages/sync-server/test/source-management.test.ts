import { runInDurableObject } from "cloudflare:test";
import {
	EVENT_CLOCK_SKEW_MS,
	exportedSignalSchema,
	LIVE_RUNS,
	LIVE_SIGNALS,
	RESTORE_ISSUE_MISSING,
	SOURCES_PER_WORKSPACE,
	type Source,
	type SourceSettings,
	STORED_EVENT_URL_MAX_BYTES,
} from "@gateweave/track-protocol";
import { expect, it } from "vitest";
import type { MemberProfile, WebhookResult } from "../src";
import { freshWorkspace } from "./client";

const owner: MemberProfile = {
	id: "owner",
	role: "owner",
	name: "Owner",
	email: "owner@example.com",
	image: null,
};
const person: MemberProfile = { ...owner, id: "member", role: "member" };
const agent: MemberProfile = { ...owner, id: "agent", role: "agent" };
// An export older than the clock skew, so a restored source can resume at once.
const exportedAt = new Date(Date.now() - 3_600_000).toISOString();
const input: SourceSettings = {
	name: "Guard",
	product: "guard",
	teamId: "test",
	closeWhenCleared: false,
	lowestSeverity: "high",
	linkOrigins: [],
};

function ok(result: WebhookResult<Source>) {
	if (!result.ok) throw Error(result.message);
	return result.value;
}

async function workspace() {
	const ws = freshWorkspace();
	const added = await ws.mutate(owner, "source-management", crypto.randomUUID(), {
		name: "team.create",
		args: { id: "test", name: "Test", key: "TST" },
	});
	expect(added.ok).toBe(true);
	await ws.syncMember(person);
	await ws.syncMember(agent);
	return ws;
}

it("R31: only active admins manage sources and every settings change appears in the audit log", async () => {
	const ws = await workspace();
	for (const id of [person.id, agent.id, "absent"]) {
		expect(await ws.manageSource(id, { kind: "create", input })).toMatchObject({
			ok: false,
			reason: "forbidden",
		});
		expect(await ws.sourcesForAdmin(id)).toMatchObject({ ok: false, reason: "forbidden" });
	}
	const { id } = ok(await ws.manageSource(owner.id, { kind: "create", input }));
	const { linkOrigins: _, ...settings } = input;
	expect(await ws.manageSource(person.id, { kind: "prepareRemoval", id })).toMatchObject({
		ok: false,
	});
	ok(await ws.manageSource(owner.id, { kind: "pause", id, paused: true }));
	expect(
		ok(
			await ws.manageSource(owner.id, {
				kind: "update",
				id,
				input: { ...settings, name: "Guard Staging" },
			}),
		).paused,
	).toBe(true);
	ok(await ws.manageSource(owner.id, { kind: "assign", id, assigneeId: agent.id }));
	ok(await ws.manageSource(owner.id, { kind: "prepareRemoval", id }));
	ok(await ws.manageSource(owner.id, { kind: "finishRemoval", id }));
	const log = await ws.auditLog(owner, {});
	expect(
		log.ok && log.value.events.filter((e) => e.target.id === id).map((e) => [e.actorId, e.action]),
	).toEqual(
		["source.deleted", "source.updated", "source.updated", "source.paused", "source.created"].map(
			(action) => [owner.id, action],
		),
	);
});

it("R17: a new source is unassigned and only a separate admin action can choose an active agent", async () => {
	const ws = await workspace();
	const source = ok(await ws.manageSource(owner.id, { kind: "create", input }));
	expect(source.assigneeId).toBeNull();
	expect(
		await ws.manageSource(owner.id, { kind: "assign", id: source.id, assigneeId: person.id }),
	).toMatchObject({ ok: false });
	expect(
		await ws.manageSource(agent.id, { kind: "assign", id: source.id, assigneeId: agent.id }),
	).toMatchObject({ ok: false });
	expect(
		ok(await ws.manageSource(owner.id, { kind: "assign", id: source.id, assigneeId: agent.id }))
			.assigneeId,
	).toBe(agent.id);
});

it("R27: the workspace refuses the next source at its limit", async () => {
	const ws = await workspace();
	for (let n = 0; n < SOURCES_PER_WORKSPACE; n++)
		ok(await ws.manageSource(owner.id, { kind: "create", input }));
	expect(await ws.manageSource(owner.id, { kind: "create", input })).toMatchObject({
		ok: false,
		retryAfter: 86400,
	});
});

it("A23: updating only the name preserves severity, close policy and origins", async () => {
	const ws = await workspace();
	const { id } = ok(
		await ws.manageSource(owner.id, {
			kind: "create",
			input: {
				...input,
				lowestSeverity: "low",
				closeWhenCleared: true,
				linkOrigins: ["https://example.com"],
			},
		}),
	);
	expect(
		ok(await ws.manageSource(owner.id, { kind: "update", id, input: { name: "New name" } })),
	).toMatchObject({
		name: "New name",
		lowestSeverity: "low",
		closeWhenCleared: true,
		linkOrigins: ["https://example.com"],
	});
});

it("a gateway can reserve a source UUID, and an invalid or duplicate id cannot create a source", async () => {
	const ws = await workspace();
	const id = crypto.randomUUID();
	expect(
		ok(
			await ws.manageSource(owner.id, { kind: "create", input, id, notAfter: Date.now() + 60_000 }),
		).id,
	).toBe(id);
	for (const refused of [id, "malformed"])
		expect(
			await ws.manageSource(owner.id, {
				kind: "create",
				input,
				id: refused,
				notAfter: Date.now() + 60_000,
			}),
		).toMatchObject({
			ok: false,
			reason: "invalid",
		});
	expect(await ws.sourcesForAdmin(owner.id)).toMatchObject({ ok: true, value: [{ id }] });
});

it("refuses a reserved source create after its approval deadline", async () => {
	const ws = await workspace();
	expect(
		await ws.manageSource(owner.id, {
			kind: "create",
			input,
			id: crypto.randomUUID(),
			notAfter: Date.now() - 1,
		}),
	).toMatchObject({ ok: false, message: "Source approval expired" });
	expect(await ws.sourcesForAdmin(owner.id)).toMatchObject({ ok: true, value: [] });
});

it("restore enforces team, role and live signal limits in one transaction", async () => {
	const ws = await workspace();
	const id = "import-" + "a".repeat(32);
	const issueId = "import-" + "b".repeat(32);
	const source = { ...input, id, assigneeId: agent.id };
	expect(
		(
			await ws.mutate(owner, "test", crypto.randomUUID(), {
				name: "issue.create",
				args: { id: issueId, teamId: "test", title: "Imported issue", sortOrder: "a0" },
			})
		).ok,
	).toBe(true);
	expect(await ws.restoreSource(person.id, { exportedAt, source, signals: [] })).toMatchObject({
		ok: false,
		reason: "forbidden",
	});
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source: { ...source, teamId: "gone" },
			signals: [],
		}),
	).toMatchObject({ ok: false, reason: "not_found" });
	const changedAt = Date.now();
	const signal = {
		key: "first",
		sourceId: id,
		kind: "alert" as const,
		issueId,
		type: null,
		subject: null,
		severity: "high" as const,
		state: "open" as const,
		url: null,
		reopens: 0,
		firstAt: changedAt - 10,
		changedAt,
	};
	const rows = Array.from({ length: LIVE_SIGNALS + 1 }, (_, i) => ({
		...signal,
		key: String(i),
		issueId: "import-" + i.toString(16).padStart(32, "0"),
	}));
	await runInDurableObject(ws, (_, state) => {
		for (const [i, row] of rows.entries())
			state.storage.sql.exec(
				"insert into issues(id,team_id,number,title,status,priority,creator_id,sort_order,version,created_at,updated_at) values(?, 'test', ?, 'Imported', 'backlog', 0, 'owner', 'a0', 1, 0, 0)",
				row.issueId,
				i + 2,
			);
	});
	expect(await ws.restoreSource(owner.id, { exportedAt, source, signals: rows })).toMatchObject({
		ok: false,
		reason: "invalid",
	});
	expect((await ws.snapshot(owner)).sources).toEqual([]);
	expect((await ws.snapshot(owner)).signals).toEqual([]);
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source,
			signals: [{ ...signal, state: "dismissed" }],
		}),
	).toMatchObject({ ok: true, value: { restored: 1, bound: 1 } });
	expect((await ws.snapshot(owner)).sources).toMatchObject([{ assigneeId: agent.id }]);
	expect(await ws.backupRead(["SELECT cleared_at FROM signals"])).toEqual([
		[{ cleared_at: changedAt }],
	]);
	const boundaryId = "import-" + "d".repeat(32);
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source: { ...source, id: boundaryId },
			signals: rows.slice(0, LIVE_SIGNALS).map((row) => ({ ...row, sourceId: boundaryId })),
		}),
	).toMatchObject({ ok: true, value: { bound: 500 } });
	const audit = await ws.auditLog(owner, {});
	expect(audit.ok && audit.value.events.filter((e) => e.target.id === id)).toMatchObject([
		{ action: "source.created", actorId: owner.id },
	]);
	const other = { ...source, id: "import-" + "c".repeat(32), assigneeId: person.id };
	expect(
		await ws.restoreSource(owner.id, { exportedAt, source: other, signals: [] }),
	).toMatchObject({
		ok: true,
	});
	expect((await ws.snapshot(owner)).sources.find((s) => s.id === other.id)?.assigneeId).toBeNull();
});

it("orders an unchanged heartbeat and delayed clear by the new sender's clock, and accepts a reopen sent after a delayed clear", async () => {
	const ws = await workspace();
	const now = Date.now();
	const id = "import-" + "e".repeat(32);
	const source = { ...input, id, assigneeId: null };
	const states = ["open", "cleared", "dismissed"] as const;
	const rows = states.map((state, i) => ({
		sourceId: id,
		kind: "alert" as const,
		key: state,
		issueId: "import-" + String(i).repeat(32),
		state,
		severity: "high" as const,
		type: null,
		subject: null,
		url: null,
		firstAt: now - 2000,
		changedAt: now,
		reopens: 0,
	}));
	for (const row of rows)
		expect(
			await ws.mutate(owner, "history", crypto.randomUUID(), {
				name: "issue.create",
				args: {
					id: row.issueId,
					teamId: "test",
					title: "Imported",
					sortOrder: "a0",
					status: row.state === "open" ? "backlog" : "done",
				},
			}),
		).toMatchObject({ ok: true });
	const future = rows[2];
	if (!future) throw Error("Missing dismissal");
	future.firstAt = future.changedAt = Date.UTC(2100, 0);
	future.reopens = 1_000_000;
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source,
			signals: [{ ...future, key: "界".repeat(6000) }],
		}),
	).toMatchObject({ ok: false });
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source,
			signals: [{ ...future, reopens: 1_000_001 }],
		}),
	).toMatchObject({ ok: false });
	for (const length of [70_000, 2_200_000]) {
		expect(
			await ws.restoreSource(owner.id, {
				exportedAt,
				source,
				signals: [{ ...future, subject: "x".repeat(length) }],
			}),
		).toMatchObject({ ok: false });
	}
	const started = Date.now();
	expect(await ws.restoreSource(owner.id, { exportedAt, source, signals: rows })).toMatchObject({
		ok: true,
		value: { bound: 3 },
	});
	const finished = Date.now();
	const restored = (await ws.snapshot(owner)).signals.find((s) => s.key === "dismissed");
	expect.soft(restored?.firstAt).toBeGreaterThanOrEqual(started);
	expect.soft(restored?.firstAt).toBeLessThanOrEqual(finished);
	expect.soft(restored?.changedAt).toBe(restored?.firstAt);
	expect
		.soft(await ws.backupRead(["select cleared_at from signals where key='dismissed'"]))
		.toEqual([[{ cleared_at: restored?.changedAt }]]);
	const checked = await ws.manageSource(owner.id, { kind: "checkKey", id });
	if (!checked.ok || !checked.value.keyId) throw Error("Missing key id");
	const keyId = checked.value.keyId;
	ok(await ws.manageSource(owner.id, { kind: "pause", id, paused: false }));
	const event = (key: string, state: "open" | "cleared", at: number) =>
		ws.sourceEvent(
			id,
			keyId,
			JSON.stringify({
				key,
				state,
				severity: "high",
				title: "Imported",
				sentAt: new Date(at).toISOString(),
			}),
			"https://track.test/test",
		);
	expect(await event("open", "open", now - 1000)).toMatchObject({
		status: 200,
		answer: { state: "open" },
	});
	expect(await event("open", "cleared", now - 1500)).toMatchObject({
		status: 200,
		answer: { state: "open" },
	});
	expect
		.soft(await event("open", "cleared", now - 500))
		.toMatchObject({ status: 200, answer: { state: "cleared" } });
	expect
		.soft(await event("cleared", "open", now - 500))
		.toMatchObject({ status: 200, answer: { state: "open" } });
	expect(await event("dismissed", "open", Date.now())).toMatchObject({
		status: 200,
		answer: { state: "open" },
	});
	const after = (await ws.snapshot(owner)).signals.find((s) => s.key === "dismissed");
	expect(exportedSignalSchema.parse(after)).toMatchObject({ reopens: 1_000_000, state: "open" });
});

it("later restores bind only the signals fitting the workspace snapshot byte budget", async () => {
	const ws = await workspace();
	const subject = "界".repeat(4000);
	const rows = Array.from({ length: 720 }, (_, i) => ({
		key: String(i).padStart(3, "0"),
		kind: "alert" as const,
		issueId: "import-" + i.toString(16).padStart(32, "0"),
		subject,
		state: "dismissed" as const,
		severity: "high" as const,
		type: null,
		url: null,
		reopens: 0,
		firstAt: 1,
		changedAt: 1,
	}));
	await runInDurableObject(ws, (_, state) => {
		for (const [i, row] of rows.entries())
			state.storage.sql.exec(
				"insert into issues(id,team_id,number,title,status,priority,creator_id,sort_order,version,created_at,updated_at) values(?, 'test', ?, 'Imported', 'backlog', 0, 'owner', 'a0', 1, 0, 0)",
				row.issueId,
				i + 1,
			);
	});
	const rowBytes = 12000 + 36 + 39 + 39 + 3 + "dismissedhigh011".length;
	const limit = Math.floor((8 * 1024 * 1024) / rowBytes);
	for (let start = 0; start < 720; start += 360) {
		const id = "import-" + String(start).padStart(32, "0");
		const bound = start === 0 ? 360 : limit - 360;
		expect(
			await ws.restoreSource(owner.id, {
				exportedAt,
				source: { ...input, id, assigneeId: null },
				signals: rows.slice(start, start + 360).map((row) => ({ ...row, sourceId: id })),
			}),
		).toMatchObject({ ok: true, value: { bound, dropped: 360 - bound, overLimit: 360 - bound } });
	}
	expect(await ws.backupRead(["select max(key) as last from signals"])).toEqual([
		[{ last: String(limit - 1) }],
	]);
});

/** Issue rows a restore can bind to, written straight into the object's storage. */
async function issueRows(ws: Awaited<ReturnType<typeof workspace>>, rows: [string, string][]) {
	await runInDurableObject(ws, (_, state) => {
		for (const [i, [id, status]] of rows.entries())
			state.storage.sql.exec(
				"insert into issues(id,team_id,number,title,status,priority,creator_id,sort_order,version,created_at,updated_at) values(?, 'test', ?, 'Imported', ?, 0, 'owner', 'a0', 1, 0, 0)",
				id,
				900 + i,
				status,
			);
	});
}

const restoredRow = (sourceId: string, key: string, issueId: string) => ({
	sourceId,
	kind: "alert" as const,
	key,
	issueId,
	type: null as string | null,
	subject: null as string | null,
	severity: "high" as const,
	state: "open" as const,
	url: null as string | null,
	reopens: 0,
	// Recent, so a cleared row is inside the retention period rather than expired.
	firstAt: Date.now() - 60_000,
	changedAt: Date.now() - 60_000,
});

it("sender order restarts after the export and the clock skew, never after the restore", async () => {
	const ws = await workspace();
	const now = Date.now();
	const [future, recent, settled] = ["1", "2", "3"].map((c) => "import-" + c.repeat(32)) as [
		string,
		string,
		string,
	];
	const [futureIssue, recentIssue, settledIssue] = ["7", "8", "9"].map(
		(c) => "import-" + c.repeat(32),
	) as [string, string, string];
	await issueRows(ws, [
		[futureIssue, "backlog"],
		[recentIssue, "backlog"],
		[settledIssue, "done"],
	]);
	const source = (id: string) => ({ ...input, id, assigneeId: null });
	const resume = async (id: string) => {
		const checked = await ws.manageSource(owner.id, { kind: "checkKey", id });
		if (!checked.ok || !checked.value.keyId) throw Error("Missing key id");
		ok(await ws.manageSource(owner.id, { kind: "pause", id, paused: false }));
		const keyId = checked.value.keyId;
		return (key: string, state: "open" | "cleared", at: number) =>
			ws.sourceEvent(
				id,
				keyId,
				JSON.stringify({
					key,
					state,
					severity: "high",
					title: "Imported",
					sentAt: new Date(at).toISOString(),
				}),
				"https://track.test/test",
			);
	};
	const floorOf = async (key: string) => {
		const [rows] = await ws.backupRead([
			`select last_sent_at as at from signals where key='${key}'`,
		]);
		return Number(rows?.[0]?.at);
	};
	// A crafted export time in the future counts as the restore's own time.
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt: "2100-01-01T00:00:00Z",
			source: source(future),
			signals: [restoredRow(future, "future", futureIssue)],
		}),
	).toMatchObject({ ok: true, value: { bound: 1 } });
	const futureFloor = await floorOf("future");
	expect(futureFloor).toBeGreaterThanOrEqual(now + EVENT_CLOCK_SKEW_MS);
	expect(futureFloor).toBeLessThanOrEqual(Date.now() + EVENT_CLOCK_SKEW_MS);
	// Within five minutes of the export, a sender's event can't be told from one sent before it,
	// so it is answered with the restored state.
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt: new Date(now).toISOString(),
			source: source(recent),
			signals: [{ ...restoredRow(recent, "recent", recentIssue), state: "cleared" }],
		}),
	).toMatchObject({ ok: true, value: { bound: 1 } });
	expect(await floorOf("recent")).toBe(now + EVENT_CLOCK_SKEW_MS);
	const recentEvent = await resume(recent);
	expect(await recentEvent("recent", "open", Date.now())).toMatchObject({
		status: 200,
		answer: { state: "cleared" },
	});
	// Exported ten minutes ago, cleared, its issue done: a sender three minutes fast replays an open
	// it sent just before the export, and it stays old; an open sent now reopens the issue.
	const exported = now - 600_000;
	// Its last change is after its first report, as an object clock that stepped back can leave it.
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt: new Date(exported).toISOString(),
			source: source(settled),
			signals: [
				{
					...restoredRow(settled, "finding", settledIssue),
					state: "cleared",
					firstAt: exported - 1000,
					changedAt: exported - 2000,
				},
			],
		}),
	).toMatchObject({ ok: true, value: { bound: 1 } });
	expect((await ws.snapshot(owner)).signals.find((s) => s.key === "finding")).toMatchObject({
		firstAt: exported - 2000,
		changedAt: exported - 2000,
	});
	const event = await resume(settled);
	expect(await event("finding", "open", exported - 1000 + 180_000)).toMatchObject({
		status: 200,
		answer: { state: "cleared" },
	});
	expect((await ws.snapshot(owner)).issues.find((i) => i.id === settledIssue)?.status).toBe("done");
	// The floor itself is still old; a millisecond after it is new.
	const floor = exported + EVENT_CLOCK_SKEW_MS;
	expect(await floorOf("finding")).toBe(floor);
	expect(await event("finding", "open", floor)).toMatchObject({
		status: 200,
		answer: { state: "cleared" },
	});
	expect(await event("finding", "open", floor + 1)).toMatchObject({
		status: 200,
		answer: { state: "open" },
	});
});

it("a signal whose issue has no row refuses the whole restore, and a deleted issue's signal drops", async () => {
	const ws = await workspace();
	const id = "import-" + "4".repeat(32);
	const deleted = "import-" + "5".repeat(32);
	const missing = "import-" + "6".repeat(32);
	await issueRows(ws, [[deleted, "backlog"]]);
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec("update issues set deleted_at = 1 where id = ?", deleted);
	});
	const source = { ...input, id, assigneeId: null };
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source,
			signals: [restoredRow(id, "gone", deleted), restoredRow(id, "unsaved", missing)],
		}),
	).toMatchObject({ ok: false, message: RESTORE_ISSUE_MISSING });
	expect((await ws.snapshot(owner)).sources).toEqual([]);
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source,
			signals: [restoredRow(id, "gone", deleted)],
		}),
	).toMatchObject({ ok: true, value: { restored: 1, bound: 0, dropped: 1, otherTeam: 0 } });
});

it("restores a stored URL up to what an event can store, as stored", async () => {
	const ws = await workspace();
	const id = "import-" + "7".repeat(32);
	const origin = "https://reports.example";
	const urls = [
		`${origin}/${"%00".repeat(3000)}`,
		`${origin}/%zz${"%E7%95%8C".repeat(3000)}`,
		`${origin}/%00${"%41".repeat(6000)}`,
		`${origin}/`,
	];
	const issueIds = urls.map((_, i) => "import-" + String(i).repeat(32));
	await issueRows(
		ws,
		issueIds.map((issue) => [issue, "backlog"]),
	);
	const source = { ...input, id, assigneeId: null, linkOrigins: [origin] };
	const rows: ReturnType<typeof restoredRow>[] = urls.map((url, i) => ({
		...restoredRow(id, `finding-${i}`, issueIds[i] ?? ""),
		url,
	}));
	// The last fills the smallest event that carries its stored fields, beside a bare origin.
	const smallest = (subject: string) =>
		new TextEncoder().encode(
			JSON.stringify({
				key: "finding-3",
				title: "x",
				severity: "high",
				state: "open",
				subject,
				sentAt: "2000-01-01T00:00:00Z",
			}),
		).length;
	const full = "s".repeat(16 * 1024 - smallest(""));
	expect(smallest(full)).toBe(16 * 1024);
	rows[3] = { ...(rows[3] ?? restoredRow(id, "finding-3", "")), subject: full };
	const tooLong = `${origin}/${"a".repeat(STORED_EVENT_URL_MAX_BYTES)}`;
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source,
			signals: [{ ...restoredRow(id, "long", issueIds[0] ?? ""), url: tooLong }],
		}),
	).toMatchObject({ ok: false, reason: "invalid" });
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source,
			signals: [{ ...(rows[3] ?? restoredRow(id, "over", "")), subject: `${full}s` }],
		}),
	).toMatchObject({ ok: false, reason: "invalid" });
	expect(await ws.restoreSource(owner.id, { exportedAt, source, signals: rows })).toMatchObject({
		ok: true,
		value: { bound: 4, dropped: 0 },
	});
	const stored = (await ws.snapshot(owner)).signals.map((signal) => signal.url).sort();
	expect(stored).toEqual([...urls].sort());
});

const restoredRun = (
	sourceId: string,
	key: string,
	issueId: string,
	state: "queued" | "running" | "passed" = "running",
) => ({
	...restoredRow(sourceId, key, issueId),
	kind: "run" as const,
	severity: "unknown" as const,
	state,
});

it("an alert and runs of one issue restore together, while a second alert still drops", async () => {
	const ws = await workspace();
	const id = "import-" + "8".repeat(32);
	const second = "import-" + "a".repeat(32);
	const [issueId, otherIssue] = ["import-" + "9".repeat(32), "import-" + "b".repeat(32)];
	await issueRows(ws, [
		[issueId, "backlog"],
		[otherIssue, "backlog"],
	]);
	// An alert, a live run and a finished one ride on one issue.
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source: { ...input, id, assigneeId: null },
			signals: [
				restoredRow(id, "alert-1", issueId),
				restoredRun(id, "run-1", issueId),
				restoredRun(id, "run-2", issueId, "passed"),
			],
		}),
	).toMatchObject({ ok: true, value: { bound: 3, dropped: 0 } });
	// From another source, a run joins them, a fresh issue takes one alert, and its second drops.
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source: { ...input, id: second, assigneeId: null },
			signals: [
				restoredRun(second, "run-3", issueId),
				restoredRow(second, "alert-2", otherIssue),
				restoredRow(second, "alert-3", otherIssue),
			],
		}),
	).toMatchObject({ ok: true, value: { bound: 2, dropped: 1, alreadyLinked: 1 } });
});

it("a restored signal's state must fit its kind", async () => {
	const ws = await workspace();
	const id = "import-" + "c".repeat(32);
	const issueId = "import-" + "d".repeat(32);
	await issueRows(ws, [[issueId, "backlog"]]);
	const source = { ...input, id, assigneeId: null };
	for (const bad of [
		// An alert's states never pass for a run, and a run's never for an alert.
		{ ...restoredRow(id, "bad-1", issueId), state: "running" as const },
		{ ...restoredRun(id, "bad-2", issueId), state: "open" as const },
	]) {
		expect(await ws.restoreSource(owner.id, { exportedAt, source, signals: [bad] })).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect((await ws.snapshot(owner)).sources).toEqual([]);
	}
});

it("a restore holds unfinished runs to the live-run limit", async () => {
	const ws = await workspace();
	const id = "import-" + "e".repeat(32);
	const issueId = "import-" + "f".repeat(32);
	await issueRows(ws, [[issueId, "backlog"]]);
	const source = { ...input, id, assigneeId: null };
	const rows = Array.from({ length: LIVE_RUNS + 1 }, (_, i) =>
		restoredRun(id, `run-${i}`, issueId),
	);
	expect(await ws.restoreSource(owner.id, { exportedAt, source, signals: rows })).toMatchObject({
		ok: false,
		reason: "invalid",
	});
	expect((await ws.snapshot(owner)).sources).toEqual([]);
	expect(
		await ws.restoreSource(owner.id, {
			exportedAt,
			source,
			signals: rows.slice(0, LIVE_RUNS),
		}),
	).toMatchObject({ ok: true, value: { bound: LIVE_RUNS, dropped: 0 } });
});
