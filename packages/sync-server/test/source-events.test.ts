import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
	ASSIGNED_PER_DAY,
	BYTES_PER_DAY,
	CALLS_PER_MINUTE,
	ISSUES_PER_DAY,
	LIVE_SIGNALS,
	type MutationInput,
	mentionedIds,
	REOPENS_PER_KEY_PER_DAY,
	SIGNAL_KEPT_DAYS,
	type SourceEvent,
	type SourceSettings,
	WORKSPACE_ISSUES_PER_DAY,
	WRITES_PER_DAY,
} from "@gateweave/track-protocol";
import { expect, it } from "vitest";
import type { MemberProfile, SourceEventResult } from "../src";
import { freshWorkspace, whole } from "./client";

const owner: MemberProfile = {
	id: "owner",
	name: "Owner",
	role: "owner",
	email: "owner@example.com",
	image: null,
};
const workspaceUrl = "https://track.example.com/test";
async function setup(config: Partial<SourceSettings> = {}) {
	const ws = freshWorkspace();
	await ws.syncMember(owner);
	const mutate = (mutation: MutationInput) =>
		ws.mutate(owner, "browser", crypto.randomUUID(), mutation);
	expect(
		(await mutate({ name: "team.create", args: { id: "team", key: "ENG", name: "Engineering" } }))
			.ok,
	).toBe(true);
	const input: SourceSettings = {
		teamId: "team",
		name: "Guard",
		product: "guard",
		linkOrigins: ["https://guard.test"],
		lowestSeverity: "high",
		closeWhenCleared: false,
		...config,
	};
	const made = await ws.manageSource(owner.id, { kind: "create", input });
	if (!made.ok) throw new Error(made.message);
	const sourceId = made.value.id;
	let sent = Date.now();
	const send = (fields: Partial<SourceEvent> = {}, id = sourceId) =>
		ws.sourceEvent(
			id,
			JSON.stringify({
				key: "build",
				state: "open",
				title: "Build failed",
				severity: "high",
				sentAt: new Date(++sent).toISOString(),
				...fields,
			}),
			workspaceUrl,
		);
	const snapshot = () => ws.snapshot(owner);
	const issue = async () => whole((await snapshot()).issues[0]);
	return { ws, send, input, sourceId, snapshot, mutate, issue };
}

function answer(response: SourceEventResult) {
	if (response.status !== 200) throw new Error(`Got ${response.status}`);
	return response.answer;
}

it("R5: a paused or missing source refuses even a malformed event", async () => {
	const { ws, sourceId } = await setup();
	expect((await ws.manageSource(owner.id, { kind: "pause", id: sourceId, paused: true })).ok).toBe(
		true,
	);
	for (const id of [sourceId, "missing"])
		expect(await ws.sourceEvent(id, null, workspaceUrl)).toEqual({ status: 404 });
});

it("R8: each source owns its key and receives only its issue link and state", async () => {
	const { ws, input, send, snapshot } = await setup();
	const other = await ws.manageSource(owner.id, { kind: "create", input });
	if (!other.ok) throw new Error(other.message);
	expect(answer(await send())).toEqual({
		state: "open",
		filed: true,
		issue: { key: "ENG-1", url: `${workspaceUrl}/issue/ENG-1` },
	});
	expect(answer(await send({}, other.value.id)).issue?.key).toBe("ENG-2");
	expect((await snapshot()).signals).toHaveLength(2);
});

it("R9: an event no later than the last taken writes nothing", async () => {
	const { send, snapshot } = await setup();
	const sentAt = new Date().toISOString();
	await send({ sentAt });
	const before = await snapshot();
	for (const at of [sentAt, new Date(0).toISOString()])
		expect(answer(await send({ sentAt: at, state: "dismissed" })).state).toBe("open");
	expect(await snapshot()).toEqual(before);
});

it("R10: a repeated state and severity leaves the log and webhook queue alone", async () => {
	const { ws, send, snapshot } = await setup();
	await ws.createWebhook(
		owner,
		{ id: "ws", slug: "test", origin: "https://track.test" },
		{
			url: "https://hooks.test/track",
			teamId: null,
			agentId: null,
			events: ["issue.updated", "issue.created"],
		},
	);
	await send();
	const before = await snapshot();
	await send({ title: "Changed", url: "https://guard.test/later" });
	expect(await snapshot()).toEqual(before);
	const hooks = await ws.webhooks(owner);
	if (!hooks.ok) throw new Error(hooks.message);
	expect(hooks.value.deliveries).toHaveLength(1);
});

it("R11: only the exact configured origin survives", async () => {
	const { send, snapshot } = await setup();
	await send({ url: "https://guard.test/look" });
	expect((await snapshot()).signals[0]?.url).toBe("https://guard.test/look");
	await send({ severity: "low", url: "https://guard.test.other.com/look" });
	expect((await snapshot()).signals[0]?.url).toBeNull();
});

it("R12: report text cannot end its fence or mention a member", async () => {
	const { send, issue } = await setup();
	const body = "~~~\n# Header\n[@Owner](mention:owner)\n![x](https://example.com)";
	await send({ title: "# [x](https://example.com)", body });
	const row = await issue();
	expect(row.title).toBe("\\# \\[x\\]\\(https\u200b\\:\\/\\/example\\.com\\)");
	expect(row.description).toBe(
		`Reported by Guard, a connected product, not a member\n\n~~~~\n${body}\n~~~~`,
	);
	expect(mentionedIds(row.description)).toEqual([]);
});

it("R13: the replica carries only signal metadata", async () => {
	const { send, snapshot } = await setup();
	await send({ body: "Private text", type: "build", subject: "main" });
	expect(Object.keys((await snapshot()).signals[0] ?? {}).sort()).toEqual(
		[
			"id",
			"sourceId",
			"key",
			"type",
			"subject",
			"severity",
			"state",
			"url",
			"issueId",
			"reopens",
			"firstAt",
			"changedAt",
		].sort(),
	);
});

it("R14: filing respects the team's threshold, first status and source actor", async () => {
	const { send, snapshot } = await setup();
	for (const severity of ["low", "unknown", "medium"] as const)
		expect(answer(await send({ severity, key: severity })).filed).toBe(false);
	expect(answer(await send()).filed).toBe(true);
	expect(whole((await snapshot()).issues[0])).toMatchObject({
		creatorId: "source",
		status: "backlog",
		intake: false,
		teamId: "team",
		assigneeId: null,
	});
	const low = await setup({ lowestSeverity: "low" });
	await low.send({ severity: "unknown" });
	expect((await low.issue()).priority).toBe(0);
});

it("R15: a team whose first status is closed retains the signal without filing", async () => {
	const { ws, send, snapshot } = await setup();
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec(
			"UPDATE statuses SET removed_at=1 WHERE category IN ('backlog','unstarted','started')",
		);
	});
	const refusal = answer(await send());
	expect(answer(await send())).toEqual(refusal);
	expect(refusal).toMatchObject({
		filed: false,
		issue: null,
		reason: expect.any(String),
	});
	expect((await snapshot()).signals).toHaveLength(1);
});

it("R16: priorities map by severity, rise and never fall", async () => {
	const { send, snapshot, issue } = await setup({ lowestSeverity: "low" });
	await send({ severity: "low" });
	expect((await issue()).priority).toBe(4);
	await send({ severity: "medium" });
	expect((await issue()).priority).toBe(3);
	await send({ severity: "high" });
	expect((await issue()).priority).toBe(2);
	await send({ severity: "critical" });
	expect((await issue()).priority).toBe(1);
	await send({ severity: "unknown" });
	expect((await issue()).priority).toBe(1);
	expect((await snapshot()).issues).toHaveLength(1);
});

it("R18: assignment requires a current member and room in the rolling allowance", async () => {
	const { ws, send, sourceId, snapshot } = await setup();
	const agent: MemberProfile = { ...owner, id: "agent", role: "agent" };
	await ws.syncMember(agent);
	expect(
		(await ws.manageSource(owner.id, { kind: "assign", id: sourceId, assigneeId: agent.id })).ok,
	).toBe(true);
	for (let i = 0; i <= ASSIGNED_PER_DAY; i++) await send({ key: String(i) });
	const after = await snapshot();
	expect(after.issues.filter((row) => whole(row).assigneeId === agent.id)).toHaveLength(
		ASSIGNED_PER_DAY,
	);
	expect(after.issues.filter((row) => whole(row).assigneeId === null)).toHaveLength(1);
	await ws.removeMember(agent.id);
	const fresh = await ws.manageSource(owner.id, {
		kind: "create",
		input: { name: "Other", product: "other", teamId: "team", linkOrigins: [] },
	});
	if (!fresh.ok) throw new Error(fresh.message);
	await ws.syncMember(agent);
	await ws.manageSource(owner.id, { kind: "assign", id: fresh.value.id, assigneeId: agent.id });
	await ws.removeMember(agent.id);
	await send({ key: "gone" }, fresh.value.id);
	expect(
		(await snapshot()).issues.filter((row) => whole(row).assigneeId === agent.id),
	).toHaveLength(ASSIGNED_PER_DAY);
});

it("R19: clearing and dismissal close eligible work and record one history entry each", async () => {
	const { send, snapshot, issue } = await setup({ closeWhenCleared: true });
	await send();
	await send({ state: "cleared" });
	expect((await issue()).status).toBe("done");
	expect((await snapshot()).activities).toHaveLength(1);
	await send();
	await send({ state: "dismissed" });
	expect((await issue()).status).toBe("canceled");
	const off = await setup();
	await off.send();
	await off.send({ state: "cleared" });
	expect((await off.issue()).status).toBe("backlog");
});

it("R20: a missing canceled status leaves a dismissed issue open", async () => {
	const { send, issue, mutate } = await setup({ closeWhenCleared: true });
	await mutate({
		name: "status.delete",
		args: { teamId: "team", key: "canceled", moveTo: "done" },
	});
	await send();
	await send({ state: "dismissed" });
	expect((await issue()).status).toBe("backlog");
});

it("R21: an offline status edit conflicts with the source's close", async () => {
	const { send, mutate, issue } = await setup({ closeWhenCleared: true });
	await send();
	const row = await issue();
	await send({ state: "cleared" });
	expect(
		await mutate({
			name: "issue.update",
			args: { id: row.id, baseVersion: row.version, patch: { status: "in_progress" } },
		}),
	).toMatchObject({ ok: false, reason: "conflict" });
	expect((await issue()).status).toBe("done");
});

it("R22: returning signals reopen the same issue with one source comment up to the cap", async () => {
	const { send, mutate, issue, snapshot } = await setup();
	await send();
	const row = await issue();
	await mutate({
		name: "issue.update",
		args: { id: row.id, baseVersion: row.version, patch: { status: "done" } },
	});
	for (let i = 0; i < REOPENS_PER_KEY_PER_DAY; i++) {
		await send({ state: "cleared" });
		expect(answer(await send()).issue?.key).toBe("ENG-1");
		expect((await issue()).status).toBe("backlog");
	}
	await send({ state: "dismissed" });
	expect(await send()).toMatchObject({ status: 429 });
	const after = await snapshot();
	expect(after.comments).toHaveLength(REOPENS_PER_KEY_PER_DAY);
	expect(after.comments.every((row) => row.authorId === "source")).toBe(true);
	expect(after.signals[0]?.reopens).toBe(REOPENS_PER_KEY_PER_DAY);
});

it("R23: repeated open leaves a person's close in place", async () => {
	const { send, mutate, issue } = await setup();
	await send();
	const row = await issue();
	await mutate({
		name: "issue.update",
		args: { id: row.id, baseVersion: row.version, patch: { status: "done" } },
	});
	await send({ severity: "critical" });
	expect((await issue()).status).toBe("done");
});

it("R24: a return after deletion files a replacement", async () => {
	const { send, issue, mutate, snapshot } = await setup();
	await send();
	const row = await issue();
	await mutate({ name: "issue.delete", args: { id: row.id } });
	await send({ state: "cleared" });
	expect(answer(await send()).issue?.key).toBe("ENG-2");
	expect((await snapshot()).signals).toHaveLength(1);
});

it("R25: concurrent deliveries allocate one issue per key and gapless versions", async () => {
	const { ws, send, snapshot } = await setup();
	const start = (await snapshot()).version;
	await Promise.all([send(), send(), send({ key: "other" })]);
	const after = await snapshot();
	expect(after.issues).toHaveLength(2);
	const versions = await runInDurableObject(ws, (_, state) =>
		state.storage.sql
			.exec<{ version: number }>(
				"SELECT version FROM oplog WHERE version > ? ORDER BY version",
				start,
			)
			.toArray()
			.map((row) => row.version),
	);
	expect(versions).toEqual(Array.from({ length: after.version - start }, (_, i) => start + i + 1));
});

it("R26: a filed issue webhook names the system actor and carries signal metadata", async () => {
	const { ws, send, sourceId } = await setup();
	const made = await ws.createWebhook(
		owner,
		{ id: "ws", slug: "test", origin: "https://track.test" },
		{ url: "https://hooks.test/track", teamId: null, agentId: null, events: ["issue.created"] },
	);
	expect(made.ok).toBe(true);
	await send({ type: "build", subject: "main" });
	const payload = await runInDurableObject(
		ws,
		(_, state) =>
			state.storage.sql
				.exec<{ payload: string }>("SELECT payload FROM webhook_deliveries LIMIT 1")
				.one().payload,
	);
	expect(JSON.parse(payload)).toMatchObject({
		data: {
			actor: { id: "source", type: "system", name: "Guard" },
			issue: {
				signal: {
					source: { id: sourceId, name: "Guard", product: "guard" },
					key: "build",
					type: "build",
					subject: "main",
					severity: "high",
					state: "open",
				},
			},
		},
	});
});

it("R27: rolling write, text, issue and workspace budgets refuse the next event", async () => {
	for (const limit of ["writes", "bytes", "issues", "workspace", "live"]) {
		const { ws, send, sourceId, snapshot } = await setup();
		await runInDurableObject(ws, (_, state) => {
			const now = Date.now();
			const sql = state.storage.sql;
			const size = limit === "writes" ? WRITES_PER_DAY : limit === "issues" ? ISSUES_PER_DAY : 1;
			const usage = Array.from({ length: size }, () => ({
				at: now,
				bytes: limit === "bytes" ? BYTES_PER_DAY : 0,
				filed: limit === "issues",
				assigned: false,
				reopened: null,
			}));
			sql.exec("UPDATE sources SET usage=? WHERE id=?", JSON.stringify(usage), sourceId);
			if (limit === "workspace")
				sql.exec(
					"INSERT INTO meta (key,value) VALUES (?,?)",
					"source_issue_times",
					JSON.stringify(Array(WORKSPACE_ISSUES_PER_DAY).fill(now)),
				);
			if (limit === "live")
				for (let i = 0; i < LIVE_SIGNALS; i++)
					sql.exec(
						"INSERT INTO signals (id,source_id,key,severity,state,first_at,changed_at,last_sent_at) VALUES (?,?,?,'low','open',0,0,0)",
						String(i),
						sourceId,
						String(i),
					);
		});
		expect(await send(), limit).toMatchObject({ status: 429, retryAfter: expect.any(Number) });
		expect((await snapshot()).signals.find((row) => row.key === "build")).toBeUndefined();
	}
});

it("R28: an exhausted call window returns a retry time and repeated refusals write nothing", async () => {
	const { ws, sourceId, send, snapshot } = await setup();
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec(
			"UPDATE sources SET call_times=? WHERE id=?",
			JSON.stringify(Array(CALLS_PER_MINUTE).fill(Date.now())),
			sourceId,
		);
	});
	expect(await send()).toMatchObject({ status: 429, retryAfter: expect.any(Number) });
	const before = await snapshot();
	expect(await send()).toMatchObject({ status: 429 });
	expect(await snapshot()).toEqual(before);
});

it("R29: the first refusal reports the exhausted limit once and never assigns its notice", async () => {
	const { ws, sourceId, send, snapshot } = await setup();
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec(
			"UPDATE sources SET call_times=? WHERE id=?",
			JSON.stringify(Array(CALLS_PER_MINUTE).fill(Date.now())),
			sourceId,
		);
	});
	await send();
	await send();
	const after = await snapshot();
	expect(after.issues).toHaveLength(1);
	expect(whole(after.issues[0])).toMatchObject({
		assigneeId: null,
		title: "Guard reached CALLS_PER_MINUTE",
	});
	expect(after.signals).toHaveLength(0);
});

it("R30: a cleared signal expires and a later open files anew", async () => {
	const { ws, send, snapshot } = await setup();
	await send();
	await send({ state: "cleared" });
	await runInDurableObject(ws, async (_, state) => {
		state.storage.sql.exec(
			"UPDATE signals SET cleared_at=?",
			Date.now() - SIGNAL_KEPT_DAYS * 86_400_000,
		);
		await state.storage.setAlarm(Date.now());
	});
	await runDurableObjectAlarm(ws);
	expect((await snapshot()).signals).toHaveLength(0);
	expect(answer(await send()).issue?.key).toBe("ENG-2");
});

it("R25: an interrupted signal insert rolls back the issue, counter and all versions", async () => {
	const { ws, send, snapshot, sourceId } = await setup();
	const before = await snapshot();
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec(
			"CREATE TRIGGER stop_signal BEFORE INSERT ON signals BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
		);
	});
	// Catch inside the object so workerd does not forward the test failure as an unhandled RPC rejection.
	const failed = await runInDurableObject(ws, (instance) => {
		try {
			instance.sourceEvent(
				sourceId,
				JSON.stringify({
					key: "build",
					state: "open",
					severity: "high",
					title: "Build failed",
					sentAt: new Date().toISOString(),
				}),
				workspaceUrl,
			);
			return false;
		} catch {
			return true;
		}
	});
	expect(failed).toBe(true);
	expect(await snapshot()).toEqual(before);
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec("DROP TRIGGER stop_signal");
	});
	expect(answer(await send()).issue?.key).toBe("ENG-1");
});

it("R22: the returning signal follows the issue to its current team's first open status", async () => {
	const { ws, send, snapshot, mutate, issue } = await setup({ closeWhenCleared: true });
	await send();
	const original = await issue();
	await send({ state: "cleared" });
	await mutate({ name: "team.create", args: { id: "team-ops", key: "OPS", name: "Operations" } });
	// Model a moved issue with the same id. This team starts at todo.
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec(
			"UPDATE statuses SET removed_at=1 WHERE team_id='team-ops' AND key='backlog'",
		);
		state.storage.sql.exec("UPDATE issues SET team_id='team-ops' WHERE id=?", original.id);
	});
	expect(answer(await send()).issue?.key).toBe("OPS-1");
	expect((await snapshot()).issues).toHaveLength(1);
	expect(await issue()).toMatchObject({ id: original.id, teamId: "team-ops", status: "todo" });
});

it("R30: changing severity while cleared does not restart retention", async () => {
	const { ws, send } = await setup();
	await send({ state: "cleared" });
	const earlier = Date.now() - 86_400_000;
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec("UPDATE signals SET cleared_at=?", earlier);
	});
	await send({ state: "cleared", severity: "critical" });
	const retained = await runInDurableObject(
		ws,
		(_, state) =>
			state.storage.sql.exec<{ cleared_at: number }>("SELECT cleared_at FROM signals").one()
				.cleared_at,
	);
	expect(retained).toBe(earlier);
});

it("R32: only a taken event can publish last-heard and at most once per hour", async () => {
	const { ws, sourceId, send, snapshot } = await setup();
	await send();
	const first = (await snapshot()).sources[0]?.lastHeardAt;
	expect(first).toEqual(expect.any(Number));
	await send({ severity: "critical" });
	expect((await snapshot()).sources[0]?.lastHeardAt).toBe(first);
	const old = Date.now() - 3_600_001;
	await runInDurableObject(ws, (_, state) => {
		state.storage.sql.exec("UPDATE sources SET last_heard_at=? WHERE id=?", old, sourceId);
	});
	await send({ severity: "critical" });
	expect((await snapshot()).sources[0]?.lastHeardAt).toBe(old);
	await send({ state: "cleared" });
	expect((await snapshot()).sources[0]?.lastHeardAt).toBeGreaterThan(old);
});

it("R18: an assignee who became a regular member receives no new source issue", async () => {
	const { ws, sourceId, send, issue } = await setup();
	const agent: MemberProfile = { ...owner, id: "automation", role: "agent" };
	await ws.syncMember(agent);
	expect(
		(await ws.manageSource(owner.id, { kind: "assign", id: sourceId, assigneeId: agent.id })).ok,
	).toBe(true);
	await ws.syncMember({ ...agent, role: "member" });
	await send();
	expect((await issue()).assigneeId).toBeNull();
});

it("R7: a title must still fit an ordinary issue after escaping, even below threshold", async () => {
	const { send, snapshot } = await setup();
	const before = await snapshot();
	for (const severity of ["high", "low"] as const) {
		expect(await send({ title: "#".repeat(257), severity })).toEqual({ status: 400 });
	}
	expect(await snapshot()).toEqual(before);
	expect(answer(await send({ title: "#".repeat(256) })).filed).toBe(true);
});
