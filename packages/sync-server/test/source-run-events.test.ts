import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MemberProfile } from "../src";
import { freshWorkspace } from "./client";

const owner: MemberProfile = {
	id: "owner",
	name: "Owner",
	role: "owner",
	email: "owner@example.com",
	image: null,
};
const workspaceUrl = "https://track.example.com/test";

async function setup() {
	const ws = freshWorkspace();
	await ws.syncMember(owner);
	const mutate = (mutation: Parameters<typeof ws.mutate>[3]) =>
		ws.mutate(owner, "browser", crypto.randomUUID(), mutation);
	expect(
		(await mutate({ name: "team.create", args: { id: "team", key: "ENG", name: "Engineering" } }))
			.ok,
	).toBe(true);
	expect(
		(
			await mutate({
				name: "issue.create",
				args: { id: "issue-1", teamId: "team", title: "Fix the flaky test", sortOrder: "a0" },
			})
		).ok,
	).toBe(true);
	const made = await ws.manageSource(owner.id, {
		kind: "create",
		input: {
			name: "Agents",
			product: "agents",
			teamId: "team",
			linkOrigins: [],
			lowestSeverity: "high",
			closeWhenCleared: false,
		},
	});
	if (!made.ok) throw new Error(made.message);
	const sourceId = made.value.id;
	let sent = Date.now();
	const send = (event: Record<string, unknown>, keyId = "key-1") =>
		ws.sourceEvent(
			sourceId,
			keyId,
			JSON.stringify({ sentAt: new Date(sent++).toISOString(), ...event }),
			workspaceUrl,
		);
	return { ws, sourceId, send, snapshot: () => ws.snapshot(owner) };
}

const run = (over: Record<string, unknown> = {}) => ({
	kind: "run",
	key: "fix-eng-1",
	state: "running",
	title: "Fix ENG-1",
	issue: "ENG-1",
	executor: "local-runner",
	agent: "Codex",
	...over,
});

describe("run events", () => {
	it("binds a run to its issue by key and files nothing", async () => {
		const { send, snapshot } = await setup();
		const result = await send(run({ state: "queued", waitReason: "waiting-for-slot" }));
		expect(result).toMatchObject({
			status: 200,
			answer: { state: "queued", filed: false, issue: { key: "ENG-1" } },
		});
		const whole = await snapshot();
		expect(whole.issues).toHaveLength(1);
		expect(whole.signals).toHaveLength(1);
		expect(whole.signals[0]).toMatchObject({
			kind: "run",
			key: "fix-eng-1",
			state: "queued",
			issueId: "issue-1",
			waitReason: "waiting-for-slot",
			executor: "local-runner",
			agentName: "Codex",
			lastContactAt: expect.any(Number),
		});
	});

	it("follows one run through its states as a single row", async () => {
		const { send, snapshot } = await setup();
		await send(run({ state: "queued" }));
		await send(run({ state: "running", progress: "3 of 5 checks" }));
		const done = await send(
			run({ state: "passed", progress: undefined, endedAt: new Date().toISOString() }),
		);
		expect(done).toMatchObject({ status: 200, answer: { state: "passed", filed: false } });
		const whole = await snapshot();
		expect(whole.signals).toHaveLength(1);
		expect(whole.signals[0]).toMatchObject({ state: "passed", progress: null });
		expect(whole.signals[0]?.startedAt).toBeNull();
		expect(whole.signals[0]?.endedAt).toEqual(expect.any(Number));
	});

	it("keeps progress under one state and ignores an older report", async () => {
		const { ws, sourceId, snapshot } = await setup();
		let sent = Date.now();
		const sendAt = (event: Record<string, unknown>) =>
			ws.sourceEvent(
				sourceId,
				"key-1",
				JSON.stringify({ sentAt: new Date(sent++).toISOString(), ...event }),
				workspaceUrl,
			);
		expect((await sendAt(run({ state: "running", progress: "1 of 5" }))).status).toBe(200);
		expect((await sendAt(run({ state: "running", progress: "2 of 5" }))).status).toBe(200);
		let whole = await snapshot();
		expect(whole.signals[0]).toMatchObject({ state: "running", progress: "2 of 5" });
		// A report sent before the last accepted one cannot move the run back.
		const stale = await ws.sourceEvent(
			sourceId,
			"key-1",
			JSON.stringify({
				sentAt: new Date(Date.now() - 60_000).toISOString(),
				...run({ state: "queued" }),
			}),
			workspaceUrl,
		);
		expect(stale).toMatchObject({ status: 200, answer: { state: "running" } });
		whole = await snapshot();
		expect(whole.signals).toHaveLength(1);
		expect(whole.signals[0]).toMatchObject({ state: "running", progress: "2 of 5" });
	});

	it("answers a reason and writes nothing for an unknown issue or a changed binding", async () => {
		const { ws, sourceId, send, snapshot } = await setup();
		const unknown = await send(run({ issue: "ENG-99" }));
		expect(unknown).toMatchObject({
			status: 200,
			answer: { filed: false, issue: null, reason: "No such issue." },
		});
		expect((await snapshot()).signals).toHaveLength(0);
		await send(run({ state: "running" }));
		expect(
			(
				await ws.mutate(owner, "browser", crypto.randomUUID(), {
					name: "issue.create",
					args: { id: "issue-2", teamId: "team", title: "Another issue", sortOrder: "a1" },
				})
			).ok,
		).toBe(true);
		const rebound = await send(run({ issue: "ENG-2" }));
		expect(rebound).toMatchObject({
			status: 200,
			answer: { filed: false, issue: { key: "ENG-1" }, reason: expect.any(String) },
		});
		const whole = await snapshot();
		expect(whole.signals).toHaveLength(1);
		expect(whole.signals[0]).toMatchObject({ state: "running", issueId: "issue-1" });
		expect(sourceId).toBeTruthy();
	});

	it("accepts a run without an issue and keeps alert and run keys apart", async () => {
		const { send, snapshot } = await setup();
		await send(run({ issue: undefined, key: "deploy-7" }));
		await send({
			kind: "alert",
			key: "deploy-7",
			state: "open",
			severity: "high",
			title: "Deploy failed",
		});
		const whole = await snapshot();
		expect(whole.signals).toHaveLength(2);
		expect(whole.signals.map((signal) => signal.kind).sort()).toEqual(["alert", "run"]);
		const unbound = whole.signals.find((signal) => signal.kind === "run");
		expect(unbound?.issueId).toBeNull();
	});

	it("refuses an alert carrying run fields and a run carrying alert fields", async () => {
		const { send } = await setup();
		for (const body of [
			{ kind: "alert", key: "a", state: "open", severity: "high", title: "T", progress: "x" },
			{ kind: "run", key: "r", state: "running", title: "T", severity: "high" },
			{ kind: "run", key: "r2", state: "open", title: "T" },
			{ kind: "run", key: "r3", state: "running", title: "T", body: "notes" },
		]) {
			expect((await send(body)).status).toBe(400);
		}
	});

	it("the alarm reclaims a finished run after 30 days but keeps an unfinished one", async () => {
		const { ws, send, snapshot } = await setup();
		await send(run({ state: "passed", endedAt: new Date().toISOString() }));
		await send(run({ key: "fix-eng-2", state: "running", issue: "ENG-1" }));
		await runInDurableObject(ws, async (_, state) => {
			state.storage.sql.exec(
				"UPDATE signals SET changed_at=? WHERE kind='run'",
				Date.now() - 31 * 86_400_000,
			);
			await state.storage.setAlarm(Date.now());
		});
		expect(await runDurableObjectAlarm(ws)).toBe(true);
		const whole = await snapshot();
		expect(whole.signals).toHaveLength(1);
		expect(whole.signals[0]).toMatchObject({ key: "fix-eng-2", state: "running" });
	});
});
