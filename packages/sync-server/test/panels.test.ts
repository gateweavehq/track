import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type MutationInput, WEBHOOK_EVENTS } from "@gateweave/track-protocol";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { MemberProfile, WebhookResult } from "../src";
import * as schema from "../src/db/schema";
import { ChangeSet } from "../src/log";
import { revealPanel } from "../src/panels";
import { freshWorkspace, TestClient } from "./client";

function member(id: string, role: MemberProfile["role"]): MemberProfile {
	return { id, name: `Seat ${id}`, role, email: `${id}@example.com`, image: null };
}
const owner = member("owner", "owner"),
	admin = member("admin", "admin"),
	a = member("alice", "member"),
	b = member("bob", "agent"),
	c = member("cara", "member"),
	reader = member("reader", "member");
const secret = "SECRET-ALPHA-7731";
const issueId = "question";
afterEach(() => {
	vi.restoreAllMocks();
});
function ok<T>(result: WebhookResult<T>) {
	if (!result.ok) throw new Error(result.message);
	return result.value;
}
async function setup() {
	const ws = freshWorkspace();
	for (const m of [owner, admin, a, b, c, reader]) await ws.syncMember(m);
	async function mutate(m: MemberProfile, body: MutationInput) {
		expect(await ws.mutate(m, "client", crypto.randomUUID(), body)).toMatchObject({ ok: true });
	}
	await mutate(owner, {
		name: "team.create",
		args: { id: "team", key: "ENG", name: "Engineering" },
	});
	await mutate(owner, {
		name: "issue.create",
		args: { id: issueId, teamId: "team", title: "Question", status: "done", sortOrder: "a0" },
	});
	const input = { issueId, seats: [a.id, b.id, c.id], deadlineAt: Date.now() + 3600000 };
	const open = async () => ok(await ws.openPanel(owner, input)).id;
	const submit = (id: string, m: MemberProfile, body: string) =>
		ws.submitPosition(m, { panelId: id, body });
	const get = (id: string, m: MemberProfile) => ws.getPanel(m, { panelId: id });
	const expire = () =>
		runInDurableObject(ws, (_, state) => {
			state.storage.sql.exec("update panels set deadline_at = 1 where state = 'open'");
		});
	return { ws, input, open, submit, get, mutate, expire };
}
async function hidden() {
	const ctx = await setup();
	const id = await ctx.open();
	expect(ok(await ctx.submit(id, a, secret)).own).toBe(secret);
	return { ...ctx, id };
}

it("only owners and admins open panels", async () => {
	const { ws, input } = await setup();
	for (const m of [a, b])
		expect(await ws.openPanel(m, input)).toMatchObject({ ok: false, reason: "forbidden" });
	for (const m of [admin, owner]) expect(ok(await ws.openPanel(m, input)).openedBy).toBe(m.id);
});
it("validates seats, issue and deadline", async () => {
	const { ws, input, mutate } = await setup();
	await ws.removeMember(reader.id);
	for (const seats of [
		[],
		[a.id, a.id],
		[reader.id],
		["missing"],
		[owner.id, admin.id, a.id, b.id, c.id, reader.id],
	])
		expect(await ws.openPanel(owner, { ...input, seats })).toMatchObject({ reason: "invalid" });
	for (const deadlineAt of [0, Date.now() + 31 * 86400000])
		expect(await ws.openPanel(owner, { ...input, deadlineAt })).toMatchObject({
			reason: "invalid",
		});
	expect(await ws.openPanel(owner, { ...input, issueId: "missing" })).toMatchObject({
		reason: "not_found",
	});
	await mutate(owner, { name: "issue.archive", args: { id: issueId, archived: true } });
	expect(await ws.openPanel(owner, input)).toMatchObject({ reason: "not_found" });
	await mutate(owner, { name: "issue.delete", args: { id: issueId } });
	expect(await ws.openPanel(owner, input)).toMatchObject({ reason: "not_found" });
});
it("counts only open panels toward the workspace limit", async () => {
	const { ws, input, submit } = await setup();
	const single = { ...input, seats: [a.id] };
	const first = ok(await ws.openPanel(admin, single));
	ok(await ws.openPanel(owner, single));
	ok(await ws.openPanel(owner, single));
	expect(await ws.openPanel(owner, single)).toMatchObject({ reason: "conflict" });
	ok(await submit(first.id, a, "done"));
	ok(await ws.openPanel(owner, single));
});
it("refuses a second position and preserves the stored body", async () => {
	const { ws, id, submit, expire } = await hidden();
	for (const body of [secret, "replacement"])
		expect(await submit(id, a, body)).toMatchObject({
			reason: "conflict",
			message: "You have already submitted a position",
		});
	expect(
		await runInDurableObject(
			ws,
			(_, s) =>
				s.storage.sql.exec("select body from panel_seats where member_id=?", a.id).one().body,
		),
	).toBe(secret);
	expect(await submit(id, b, "x".repeat(20001))).toMatchObject({ reason: "invalid" });
	expect(await submit(id, admin, "new")).toMatchObject({ reason: "not_found" });
	expect(await submit("missing", a, "new")).toMatchObject({ reason: "not_found" });
	await expire();
	expect(await submit(id, b, "late")).toMatchObject({
		reason: "conflict",
		message: "The panel is closed",
	});
});
it("get_panel hides text from other seats and admins and hides the panel from other members", async () => {
	const { id, get, ws } = await hidden();
	expect(ok(await get(id, a)).own).toBe(secret);
	for (const m of [admin, owner, b, c]) {
		const view = ok(await get(id, m));
		expect(view).toMatchObject({
			own: null,
			positions: null,
			absent: null,
			seats: [
				{ memberId: a.id, submitted: true },
				{ memberId: b.id, submitted: false },
				{ memberId: c.id, submitted: false },
			],
		});
		expect(JSON.stringify(view)).not.toContain(secret);
	}
	expect(await get(id, reader)).toMatchObject({ reason: "not_found" });
	await ws.removeMember(a.id);
	expect(await get(id, a)).toMatchObject({ reason: "forbidden" });
});
it("snapshots hide positions from seats and admins", async () => {
	const { ws } = await hidden();
	for (const m of [b, admin]) expect(JSON.stringify(await ws.snapshot(m))).not.toContain(secret);
});
it("issue and comment reads hide positions", async () => {
	const { ws } = await hidden();
	for (const value of [
		await ws.issue(issueId),
		await ws.issues({ limit: 20 }),
		await ws.comments(issueId),
	])
		expect(JSON.stringify(value)).not.toContain(secret);
});
it("issue search cannot find a hidden position", async () => {
	const { ws } = await hidden();
	expect(await ws.issues({ text: secret, limit: 20 })).toEqual([]);
});
it("the oplog and socket deltas hide pending positions", async () => {
	const { ws, open, submit, mutate } = await setup();
	const id = await open();
	const client = await TestClient.live(ws, b);
	const version = (await ws.snapshot(b)).version;
	ok(await submit(id, a, secret));
	expect((await ws.snapshot(b)).version).toBe(version);
	await mutate(owner, { name: "comment.create", args: { id: "marker", issueId, body: "Public" } });
	await client.op((op) => op.id === "marker");
	expect(JSON.stringify(client.ops())).not.toContain(secret);
	expect(
		await runInDurableObject(ws, (_, s) =>
			JSON.stringify(s.storage.sql.exec("select * from oplog").toArray()),
		),
	).not.toContain(secret);
	client.close();
});
it("webhooks get the reveal comments and no hidden position", async () => {
	const { ws, open, submit } = await setup();
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
	ok(
		await ws.createWebhook(
			owner,
			{ id: "ws", slug: "test", origin: "https://track.test" },
			{
				url: "https://hooks.test/panels",
				events: [...WEBHOOK_EVENTS],
				teamId: null,
				agentId: null,
			},
		),
	);
	const deliveries = () =>
		runInDurableObject(ws, (_, s) =>
			s.storage.sql.exec("select event,payload from webhook_deliveries").toArray(),
		);
	const id = await open();
	ok(await submit(id, a, secret));
	expect(JSON.stringify(await deliveries())).not.toContain(secret);
	ok(await submit(id, b, "second"));
	ok(await submit(id, c, "third"));
	const rows = await deliveries();
	expect(rows.filter((r) => r.event === "comment.created")).toHaveLength(4);
	expect(JSON.stringify(rows)).toContain(secret);
});
it("only panel_seats stores the hidden text", async () => {
	const { ws } = await hidden();
	const found = await runInDurableObject(ws, (_, s) => {
		const db = s.storage.sql;
		const tables = db
			.exec<{ name: string }>(
				"select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_cf_%'",
			)
			.toArray();
		return tables
			.filter(({ name }) =>
				db
					.exec(`select * from "${name.replaceAll('"', '""')}"`)
					.toArray()
					.some((row) =>
						Object.values(row).some((value) =>
							(value instanceof ArrayBuffer
								? new TextDecoder().decode(value)
								: String(value)
							).includes(secret),
						),
					),
			)
			.map((t) => t.name);
	});
	expect(found).toEqual(["panel_seats"]);
});
it("last submit publishes all aliased Track comments in one consecutive delta", async () => {
	const { ws, id, get, submit } = await hidden();
	ok(await submit(id, b, "second"));
	const client = await TestClient.live(ws, b);
	const before = (await ws.snapshot(b)).version;
	const panel = ok(await submit(id, c, "third"));
	expect(panel).toMatchObject({
		state: "revealed",
		own: null,
		revealReason: "complete",
		absent: [],
	});
	const comments = await ws.comments(issueId);
	expect(comments).toHaveLength(4);
	expect(comments.every((row) => row.authorId === "system")).toBe(true);
	expect(comments[0]?.body).toMatch(/3 of 3.*Absent: none/);
	const positions = panel.positions ?? [];
	expect(positions.map((p) => p.alias)).toEqual(["Position A", "Position B", "Position C"]);
	expect(new Set(positions.map((p) => p.body))).toEqual(new Set([secret, "second", "third"]));
	for (const p of positions) expect(Object.keys(p).sort()).toEqual(["alias", "body"]);
	expect(comments.slice(1).map((r) => r.body)).toEqual(
		positions.map((p) => `**${p.alias}**\n\n${p.body}`),
	);
	const delta = await client.take(
		(m): m is Extract<typeof m, { type: "delta" }> => m.type === "delta" && m.from === before + 1,
	);
	if (delta.type !== "delta") throw new Error("Missing reveal delta");
	expect(delta.ops.filter((op) => op.entity === "comment").map((op) => op.version)).toEqual(
		[1, 2, 3, 4].map((n) => before + n),
	);
	expect(ok(await get(id, reader))).toEqual(panel);
	expect(await submit(id, c, "again")).toMatchObject({
		reason: "conflict",
		message: "The panel is closed",
	});
	client.close();
});
it.each([0, 2])(
	"the alarm reveals %i submissions at the deadline and names absent seats",
	async (n) => {
		const { ws, open, submit, get, expire, input } = await setup();
		const id = await open();
		await runDurableObjectAlarm(ws);
		expect(ok(await get(id, a)).state).toBe("open");
		expect(await runInDurableObject(ws, (_, state) => state.storage.getAlarm())).toBe(
			input.deadlineAt,
		);
		if (n) {
			ok(await submit(id, a, "first"));
			ok(await submit(id, b, "second"));
		}
		await expire();
		await runDurableObjectAlarm(ws);
		expect(ok(await get(id, reader))).toMatchObject({
			state: "revealed",
			revealReason: "deadline",
			absent: n ? [c.id] : [a.id, b.id, c.id],
		});
		const comments = await ws.comments(issueId);
		expect(comments).toHaveLength(n + 1);
		expect(comments[0]?.body).toContain(
			`Absent: ${(n ? [c] : [a, b, c]).map((m) => m.name).join(", ")}.`,
		);
		await runDurableObjectAlarm(ws);
		expect(await ws.comments(issueId)).toEqual(comments);
	},
);
it("a stale deadline reveal after the last submit writes no second batch", async () => {
	const { ws, open, submit } = await setup();
	const id = await open();
	const stale = await runInDurableObject(
		ws,
		(_, s) => drizzle(s.storage, { schema }).select().from(schema.panels).all()[0],
	);
	if (!stale) throw new Error("Missing panel");
	for (const m of [a, b, c]) ok(await submit(id, m, m.name));
	await runInDurableObject(ws, (_, s) =>
		s.storage.transactionSync(() => {
			const db = drizzle(s.storage, { schema });
			const now = Date.now();
			revealPanel(db, new ChangeSet(db, null, now), stale, "deadline", now);
		}),
	);
	expect(await ws.comments(issueId)).toHaveLength(4);
});
it.each(["archived", "deleted"])("reveals without comments on a %s issue", async (state) => {
	const { ws, open, submit, mutate, get } = await setup();
	const id = await open();
	await mutate(
		owner,
		state === "archived"
			? { name: "issue.archive", args: { id: issueId, archived: true } }
			: { name: "issue.delete", args: { id: issueId } },
	);
	for (const m of [a, b, c]) ok(await submit(id, m, m.name));
	expect(ok(await get(id, reader)).positions).toHaveLength(3);
	expect(
		await runInDurableObject(ws, (_, s) => s.storage.sql.exec("select * from comments").toArray()),
	).toEqual([]);
});
it("notifies issue subscribers only at reveal", async () => {
	const { ws, open, submit, mutate } = await setup();
	const id = await open();
	await mutate(c, { name: "issue.subscribe", args: { issueId, subscribed: true } });
	ok(await submit(id, a, secret));
	expect((await ws.snapshot(c)).inbox).toEqual([]);
	expect((await ws.snapshot(owner)).inbox).toEqual([]);
	ok(await submit(id, b, "second"));
	ok(await submit(id, c, "third"));
	expect((await ws.snapshot(owner)).inbox).toContainEqual(
		expect.objectContaining({ issueId, actorId: "system", unread: 4 }),
	);
});
