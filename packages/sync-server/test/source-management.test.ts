import { SOURCES_PER_WORKSPACE, type Source, type SourceSettings } from "@gateweave/track-protocol";
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
