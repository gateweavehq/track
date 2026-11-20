import {
	type AuditPage,
	type Snapshot,
	SOURCES_PER_WORKSPACE,
	type SourceAction,
} from "@gateweave/track-protocol";
import type { WorkspaceDO } from "@gateweave/track-sync-server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb } from "../src/server/db";
import { applyD1Migration, faulty, migratedD1 } from "../src/server/db/faulty-d1";
import { applySourceAction, type SourceCommand } from "../src/server/source-admin";
import { findSourceByKey, sourceKeys } from "../src/server/source-keys";
import { serverFunctions } from "./server-functions";
import { startTrack } from "./track-worker";

const origin = "https://track.test";
let track: Awaited<ReturnType<typeof startTrack>>;
beforeAll(async () => {
	track = await startTrack(origin, { isolates: 2, isolateVars: [{}, { TRACK_DEMO: "1" }] });
});
afterAll(async () => {
	await track?.dispose();
});

async function setup() {
	const id = crypto.randomUUID();
	const owner = {
		id: "owner",
		name: "Owner",
		role: "owner",
		image: null,
		email: "owner@example.com",
	};
	await track.db
		.prepare("insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)")
		.bind(id, id, id, Date.now())
		.run();
	await track.mutate(id, owner, {
		name: "team.create",
		args: { id: "team", name: "Team", key: "TST" },
	});
	const injected = faulty(track.db as unknown as D1Database);
	const db = createDb(injected.database);
	const manage = (command: SourceCommand) =>
		track.rpc<ReturnType<WorkspaceDO["manageSource"] | WorkspaceDO["revokeSourceKey"]>>(
			id,
			command.kind === "prepareRevoke" || command.kind === "keyRevoked"
				? "revokeSourceKey"
				: "manageSource",
			owner.id,
			command,
		);
	const apply = (action: SourceAction) => applySourceAction(db, id, manage, action);
	const made = await apply({
		kind: "create",
		input: { name: "Guard", product: "guard", teamId: "team", linkOrigins: [] },
	});
	if (!made.ok || !made.value.secret) throw Error("Could not create source");
	const initial = made.value.secret;
	const [key] = await sourceKeys(db, id);
	if (!key) throw Error("Missing key");
	const send = (secret: string) =>
		track.fetch(`${origin}/api/events`, {
			method: "POST",
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
			body: JSON.stringify({
				key: "finding",
				sentAt: "2026-11-18T12:00:00Z",
				title: "Finding",
				severity: "high",
				state: "open",
			}),
		});
	return { db, id, owner, injected, apply, manage, key, initial, send };
}

it("a source whose first key fails is reported as made, so trying again makes no second source", async () => {
	const { db, id, owner, injected, apply } = await setup();
	injected.state.only = /insert into "source_key"/i;
	injected.state.failures = 1;
	const made = await apply({
		kind: "create",
		input: { name: "Status", product: "status", teamId: "team", linkOrigins: [] },
	});
	expect(made).toEqual({ ok: true, value: { keyMissing: true } });
	const snap = await track.rpc<Snapshot>(id, "snapshot", owner);
	const status = snap.sources.filter((source) => source.name === "Status");
	expect(status).toHaveLength(1);
	const sourceId = status[0]?.id ?? "";
	expect((await sourceKeys(db, id)).filter((key) => key.sourceId === sourceId)).toEqual([]);
	const key = await apply({ kind: "makeKey", id: sourceId });
	expect(key).toMatchObject({ ok: true, value: { secret: expect.stringMatching(/^gws_/) } });
});

it("R4: simultaneous rotations leave at most two usable keys and listings never show either secret", async () => {
	const { db, id, apply, key, initial, send } = await setup();
	const rotations = await Promise.all([
		apply({ kind: "makeKey", id: key.sourceId }),
		apply({ kind: "makeKey", id: key.sourceId }),
	]);
	const second = rotations.find((r) => r.ok);
	if (!second?.ok || !second.value.secret) throw Error("No replacement key");
	expect(rotations.filter((r) => r.ok)).toHaveLength(1);
	const rows = await sourceKeys(db, id);
	expect(rows).toHaveLength(2);
	for (const secret of [initial, second.value.secret]) {
		expect(JSON.stringify(rows)).not.toContain(secret);
		expect((await send(secret)).status).toBe(200);
	}
	expect(await apply({ kind: "revokeKey", id: key.sourceId, keyId: key.id })).toMatchObject({
		ok: true,
	});
	expect((await send(initial)).status).toBe(404);
	expect((await send(second.value.secret)).status).toBe(200);
});

it("R33: a failed D1 revocation seals the source until retry removes the keys and signals but keeps its issue", async () => {
	const { db, id, owner, injected, apply, key, initial, send } = await setup();
	const accepted = await send(initial);
	expect(accepted.status).toBe(200);
	injected.state.only = /delete from "source_key"/i;
	injected.state.failures = 1;
	await expect(apply({ kind: "delete", id: key.sourceId })).rejects.toThrow();
	expect(await findSourceByKey(db, initial)).toMatchObject({ sourceId: key.sourceId });
	expect((await send(initial)).status).toBe(404);
	expect(await apply({ kind: "makeKey", id: key.sourceId })).toMatchObject({ ok: false });
	expect(await apply({ kind: "delete", id: key.sourceId })).toMatchObject({ ok: true });
	expect(await findSourceByKey(db, initial)).toBeNull();
	const snap = await track.rpc<Snapshot>(id, "snapshot", owner);
	expect(snap.sources).toEqual([]);
	expect(snap.signals).toEqual([]);
	expect(snap.issues).toHaveLength(1);
});

it("removing a source deletes the revoke proof and revoked key ids left by a failed D1 key deletion", async () => {
	const { id, injected, apply, key, initial, send } = await setup();
	injected.state.only = /delete from "source_key"/i;
	injected.state.failures = 1;
	await expect(apply({ kind: "revokeKey", id: key.sourceId, keyId: key.id })).rejects.toThrow();
	// The key is still in D1, but the object already refuses it.
	expect((await send(initial)).status).toBe(404);
	const proofs = () =>
		track.rpc(id, "backupRead", [
			"SELECT key, value FROM meta WHERE key GLOB 'source-revoke*' ORDER BY key",
		]);
	expect(await proofs()).toEqual([
		[
			{ key: `source-revoke:${key.id}`, value: key.sourceId },
			{ key: `source-revoked:${key.id}`, value: key.sourceId },
		],
	]);
	expect(await apply({ kind: "delete", id: key.sourceId })).toMatchObject({ ok: true });
	expect(await proofs()).toEqual([[]]);
});

let address = 0;
const freshAddress = () => `203.0.113.${++address}`;
const serverFn = serverFunctions(origin, (url, init) => track.fetch(url, init), freshAddress);
const demoFn = serverFunctions(
	origin,
	(url, init) =>
		track.fetchIn(1, url, {
			...init,
			headers: {
				...Object.fromEntries(new Headers(init?.headers)),
				"sec-fetch-site": "same-origin",
			},
		}),
	freshAddress,
);

async function signedUp(name: string) {
	const email = `${name}@source.test`;
	const res = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "content-type": "application/json", "cf-connecting-ip": freshAddress() },
		body: JSON.stringify({ name, email, password: "a-long-test-password" }),
	});
	expect(res.status).toBe(200);
	const { user } = (await res.json()) as { user: { id: string } };
	return {
		id: user.id,
		name,
		email,
		image: null,
		role: "admin",
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; "),
	};
}

async function addAdmin(id: string, name: string) {
	const admin = await signedUp(name);
	await track.db
		.prepare(
			"insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), id, admin.id, "admin", Date.now())
		.run();
	await track.rpc(id, "syncMember", {
		id: admin.id,
		name: admin.name,
		email: admin.email,
		role: "admin",
		image: null,
	});
	return admin;
}

it("R31: D1 demotion and a foreign Origin each bar a signed-in admin at the settings gateway", async () => {
	const { id, key } = await setup();
	const admin = await addAdmin(id, "source-admin");
	const data = { workspace: id, action: { kind: "makeKey", id: key.sourceId } };
	const { cookie } = admin;
	expect((await serverFn("getSourceSettings", "GET", id, { cookie })).result).toMatchObject({
		sources: [{ id: key.sourceId }],
	});
	expect(
		(await serverFn("changeSource", "POST", data, { cookie, from: "https://stranger.test" }))
			.status,
	).toBe(403);
	// D1 changes first. The object's view stays deliberately stale, so only the gateway can catch this.
	for (const role of ["member", "agent"]) {
		await track.db
			.prepare("update member set role = ? where organization_id = ? and user_id = ?")
			.bind(role, id, admin.id)
			.run();
		expect((await serverFn("getSourceSettings", "GET", id, { cookie })).result).toBeNull();
		expect((await serverFn("changeSource", "POST", data, { cookie })).result).toMatchObject({
			ok: false,
		});
	}
	const count = await track.db
		.prepare("select count(*) as n from source_key where organization_id = ?")
		.bind(id)
		.first<number>("n");
	expect(count).toBe(1);
});

it("R6: even a signed-in admin cannot read sources or make a key on the public demo", async () => {
	const { id, key } = await setup();
	const admin = await addAdmin(id, "source-demo");
	const { cookie } = admin;
	expect((await serverFn("getSourceSettings", "GET", id, { cookie })).result).toMatchObject({
		sources: [{ id: key.sourceId }],
	});
	expect((await demoFn("getSourceSettings", "GET", id, { cookie })).result).toBeNull();
	expect(
		(
			await demoFn(
				"changeSource",
				"POST",
				{ workspace: id, action: { kind: "makeKey", id: key.sourceId } },
				{ cookie },
			)
		).result,
	).toMatchObject({ ok: false });
});

it("R33: a D1 failure after committing revocation leaves an inert source before its signals are removed", async () => {
	const { db, id, owner, injected, apply, key, initial, send } = await setup();
	expect((await send(initial)).status).toBe(200);
	injected.state.only = /delete from "source_key"/i;
	injected.state.failures = 1;
	injected.state.afterSend = true;
	await expect(apply({ kind: "delete", id: key.sourceId })).rejects.toThrow();
	expect(await findSourceByKey(db, initial)).toBeNull();
	expect((await send(initial)).status).toBe(404);
	const interrupted = await track.rpc<Snapshot>(id, "snapshot", owner);
	expect(interrupted.sources).toMatchObject([{ id: key.sourceId, paused: true }]);
	expect(interrupted.signals).toHaveLength(1);
	expect(await apply({ kind: "delete", id: key.sourceId })).toMatchObject({ ok: true });
	const finished = await track.rpc<Snapshot>(id, "snapshot", owner);
	expect(finished.sources).toEqual([]);
	expect(finished.signals).toEqual([]);
	expect(finished.issues).toHaveLength(1);
});

it("R28: refusing another source returns 429 and Retry-After through the settings gateway", async () => {
	const { id, apply } = await setup();
	const { cookie } = await addAdmin(id, "source-limit");
	const action = {
		kind: "create",
		input: { name: "Status", product: "status", teamId: "team", linkOrigins: [] },
	} as const;
	for (let i = 1; i < SOURCES_PER_WORKSPACE; i++)
		expect((await apply({ kind: "create", input: { ...action.input, linkOrigins: [] } })).ok).toBe(
			true,
		);
	const result = await serverFn("changeSource", "POST", { workspace: id, action }, { cookie });
	expect(result.status).toBe(429);
	expect(Number(result.headers.get("Retry-After"))).toBeGreaterThan(0);
	expect(result.result).toMatchObject({ ok: false });
});

it("R33: a rotation admitted just before removal cannot leave a new key behind", async () => {
	const { db, id, apply, manage, key } = await setup();
	const rotate = await applySourceAction(
		db,
		id,
		async (command) => {
			const result = await manage(command);
			if (command.kind === "checkKey")
				expect(await apply({ kind: "delete", id: key.sourceId })).toMatchObject({ ok: true });
			return result;
		},
		{ kind: "makeKey", id: key.sourceId },
	);
	expect(rotate).toMatchObject({ ok: false });
	expect(await sourceKeys(db, id)).toEqual([]);
});

it("R52: upgrading D1 adds only the empty key table and its indexes to an existing deployment", async () => {
	const migration = "0016_source_key.sql";
	const { d1, dispose } = await migratedD1("before-sources", { before: migration });
	try {
		await d1
			.prepare("insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)")
			.bind("existing", "Existing", "existing", 1)
			.run();
		const objects = d1.prepare("select type, name, tbl_name, sql from sqlite_master order by name");
		const before = (await objects.all()).results;
		await applyD1Migration(d1, migration);
		const after = (await objects.all()).results;
		expect(after.filter((row) => row.tbl_name !== "source_key")).toEqual(before);
		expect(
			after.filter((row) => row.tbl_name === "source_key" && row.type === "table"),
		).toHaveLength(1);
		expect(await d1.prepare("select count(*) from source_key").first("count(*)")).toBe(0);
		expect(
			await d1.prepare("select name from organization where id=?").bind("existing").first("name"),
		).toBe("Existing");
	} finally {
		await dispose();
	}
});

it.each([false, true])(
	"A21: retry audits a D1 revocation once after object failure (committed=%s)",
	async (committed) => {
		const { db, id, manage, apply, key, initial, owner } = await setup();
		const action = { kind: "revokeKey", id: key.sourceId, keyId: key.id } as const;
		await expect(
			applySourceAction(
				db,
				id,
				async (command) => {
					if (command.kind === "keyRevoked") {
						expect(await findSourceByKey(db, initial)).toBeNull();
						if (committed) await manage(command);
						throw Error("Audit unavailable");
					}
					return manage(command);
				},
				action,
			),
		).rejects.toThrow("Audit unavailable");
		expect(await apply(action)).toMatchObject({ ok: true });
		expect(await apply(action)).toMatchObject({ ok: true });
		const log = await track.rpc<{ ok: true; value: AuditPage }>(id, "auditLog", owner, {});
		expect(log.value.events.filter((e) => e.action === "source.keyRevoked")).toMatchObject([
			{ target: { id: key.sourceId }, detail: { keyId: key.id } },
		]);
	},
);

it.each([false, true])(
	"A21: settings list a partially created key after failed cleanup (source removed=%s)",
	async (removed) => {
		const { db, id, injected, manage, apply, key } = await setup();
		const { cookie } = await addAdmin(id, "partial-source-key-" + removed);
		injected.state.only = /delete from "source_key"/i;

		await expect(
			applySourceAction(
				db,
				id,
				async (command) => {
					if (removed && command.kind === "checkKey") {
						const result = await manage(command);
						expect(await apply({ kind: "delete", id: key.sourceId })).toMatchObject({ ok: true });
						return result;
					}
					if (command.kind === "keyCreated") {
						injected.state.failures = 1;
						if (removed) return manage(command);
						return { ok: false, reason: "not_found", message: "Source unavailable" };
					}
					return manage(command);
				},
				{ kind: "makeKey", id: key.sourceId },
			),
		).rejects.toThrow();
		const remaining = (await sourceKeys(db, id)).find((row) => row.id !== key.id);
		if (!remaining) throw Error("Missing partially created key");
		expect((await serverFn("getSourceSettings", "GET", id, { cookie })).result).toMatchObject({
			keys: expect.arrayContaining([remaining]),
		});
		expect(await apply({ kind: "revokeKey", id: key.sourceId, keyId: remaining.id })).toMatchObject(
			{
				ok: true,
			},
		);
		expect(await sourceKeys(db, id)).toEqual(removed ? [] : [key]);
	},
);
