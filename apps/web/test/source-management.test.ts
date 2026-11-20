import {
	type AuditPage,
	RESTORE_ISSUE_MISSING,
	type RestoreCounts,
	type Snapshot,
	SOURCES_PER_WORKSPACE,
	type SourceAction,
	type SourceRestore,
} from "@gateweave/track-protocol";
import type { WorkspaceDO } from "@gateweave/track-sync-server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { workspaceToJson } from "../src/lib/export";
import { readJsonImport } from "../src/lib/import/json";
import { importId, planImport, restoreImportSources, runImport } from "../src/lib/import/plan";
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
	const sealed = await send(initial);
	expect(sealed.status).toBe(503);
	expect(sealed.headers.get("retry-after")).toBe("60");
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

async function report(
	secret: string,
	key: string,
	severity: "critical" | "high" = "high",
	at = Date.now() + 1000,
) {
	return track.fetch(origin + "/api/events", {
		method: "POST",
		headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
		body: JSON.stringify({
			key,
			severity,
			state: "open",
			title: key,
			sentAt: new Date(at).toISOString(),
		}),
	});
}

async function exportedWorkspace() {
	const original = await setup();
	// Sent and exported a while ago, so an import now is past the sender-order window.
	const sent = Date.now() - 20 * 60_000;
	for (const key of ["first", "second"])
		expect((await report(original.initial, key, "high", sent)).status).toBe(200);
	const snapshot = await track.rpc<Snapshot>(original.id, "snapshot", original.owner);
	const file = workspaceToJson(
		{ ...snapshot, workspace: { slug: "from", name: "From" } },
		null,
		new Date(sent + 5 * 60_000),
	);
	expect(file).not.toContain(original.initial);
	expect(file).not.toContain(original.key.id);
	const hash = await track.db
		.prepare("select hash from source_key where id=?")
		.bind(original.key.id)
		.first<string>("hash");
	if (!hash) throw Error("Missing key hash");
	expect(file).not.toContain(hash);
	return { file, snapshot };
}

async function destination() {
	const id = crypto.randomUUID();
	await track.db
		.prepare("insert into organization (id,name,slug,created_at) values (?,?,?,?)")
		.bind(id, id, id, Date.now())
		.run();
	const member = await addAdmin(id, id);
	await track.mutate(id, member, {
		name: "team.create",
		args: { id: "destination", name: "Team", key: "TST" },
	});
	const snapshot = () => track.rpc<Snapshot>(id, "snapshot", member);
	const restore = async (input: SourceRestore) =>
		(
			await serverFn<{ ok: true; value: RestoreCounts } | { ok: false; message: string }>(
				"restoreSource",
				"POST",
				{ workspace: id, input },
				{ cookie: member.cookie },
			)
		).result;
	async function load(
		file: string,
		keepTeams = false,
		expectedFailures: string[] = [],
		expectedNotes: string[] = [],
		// An issue create that never reaches the server, as from a tab closed mid-import.
		lostCreate?: string,
	) {
		const { source } = readJsonImport(file);
		const here = await snapshot();
		const plan = await planImport(
			source,
			{
				...here,
				issues: new Map(here.issues.map((row) => [row.id, row])),
				comments: new Map(),
				relations: new Map(),
				projectUpdates: new Map(),
			},
			"destination",
			{ keepTeams },
		);
		expect(plan.repeatedNotes).toEqual(expectedNotes);
		const progress = await runImport(
			async (mutation) => {
				const answer = await track.rpc<ReturnType<WorkspaceDO["mutate"]>>(
					id,
					"mutate",
					member,
					"import",
					crypto.randomUUID(),
					mutation,
				);
				if (!answer.ok) throw new Error(answer.message);
				return 0;
			},
			plan.mutations.filter(
				(mutation) => !(mutation.name === "issue.create" && mutation.args.id === lostCreate),
			),
			() => {},
		);
		expect(progress.failed.map((failure) => failure.message)).toEqual(expectedFailures);
		await restoreImportSources(plan, progress, restore);
		return progress.sourceResult;
	}
	const change = async (action: SourceAction) =>
		(
			await serverFn<{ ok: boolean; value: { secret?: string } }>(
				"changeSource",
				"POST",
				{ workspace: id, action },
				{ cookie: member.cookie },
			)
		).result;
	return { id, member, snapshot, load, change, restore };
}

it("round trip restores a paused keyless source and binds both imported issues", async () => {
	const { file, snapshot } = await exportedWorkspace();
	const dest = await destination();
	expect(await dest.load(file)).toBe(
		"1 source restored, 0 already present, 2 signals bound, 0 dropped.",
	);
	const after = await dest.snapshot();
	const id = await importId("track-source:" + snapshot.sources[0]?.id);
	expect(after.sources).toMatchObject([{ id, paused: true, teamId: "destination" }]);
	expect(await sourceKeys(createDb(track.db as unknown as D1Database), dest.id)).toEqual([]);
	const bindings = await Promise.all(
		snapshot.signals.map(async (signal) => ({
			...signal,
			id: expect.any(String),
			sourceId: id,
			issueId: await importId("track:" + signal.issueId),
		})),
	);
	expect(after.signals).toEqual(expect.arrayContaining(bindings));
	expect(after.issues.map((i) => i.id).sort()).toEqual(bindings.map((row) => row.issueId).sort());
});

it("a new key continues the imported issue and repeating the import leaves the active source alone", async () => {
	const { file } = await exportedWorkspace();
	const dest = await destination();
	await dest.load(file, true);
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw new Error("Missing restored source");
	const { id } = source;
	const key = await dest.change({ kind: "makeKey", id });
	if (!key.ok || !key.value.secret) throw new Error("No new key");
	expect(await dest.change({ kind: "pause", id, paused: false })).toMatchObject({ ok: true });
	expect(
		await track.mutate(dest.id, dest.member, {
			name: "team.update",
			args: { id: source.teamId, patch: { key: "REN", name: "Renamed" } },
		}),
	).toMatchObject({ ok: true });
	const before = await dest.snapshot();
	expect(await dest.load(file, true)).toBe(
		"0 sources restored, 1 already present, 0 signals bound, 0 dropped.",
	);
	const row = readJsonImport(file).source.sources?.[0];
	if (!row) throw Error("Missing exported source");
	expect(
		await dest.restore({
			exportedAt: row.exportedAt,
			source: { ...row.source, teamId: "old-team" },
			signals: row.signals,
		}),
	).toMatchObject({ ok: true, value: { present: 1, restored: 0, bound: 0 } });
	expect(await dest.snapshot()).toEqual(before);
	expect((await report(key.value.secret, "first", "critical")).status).toBe(200);
	const after = await dest.snapshot();
	expect(after.issues).toHaveLength(2);
	const signal = before.signals.find((s) => s.key === "first");
	expect(after.issues.find((i) => i.id === signal?.issueId)).toMatchObject({ priority: 1 });
});

it("an issue create that never landed holds the source back until the same file is imported again", async () => {
	const { file } = await exportedWorkspace();
	const [first] = JSON.parse(file).issues;
	const dest = await destination();
	expect(await dest.load(file, false, [], [], await importId("track:" + first.id))).toBe(
		`0 sources restored, 0 already present, 0 signals bound, 0 dropped. ${RESTORE_ISSUE_MISSING}`,
	);
	expect((await dest.snapshot()).sources).toEqual([]);
	expect((await dest.snapshot()).signals).toEqual([]);
	expect(await dest.load(file)).toBe(
		"1 source restored, 0 already present, 2 signals bound, 0 dropped.",
	);
});

it("a signal whose issue was left out is dropped and counted", async () => {
	const { file } = await exportedWorkspace();
	const partial = JSON.parse(file);
	const omitted = partial.issues.pop();
	const dest = await destination();
	await dest.load(JSON.stringify({ ...partial, issues: [omitted], signals: [], sources: [] }));
	expect((await dest.snapshot()).issues).toHaveLength(1);
	expect(await dest.load(JSON.stringify(partial))).toBe(
		"1 source restored, 0 already present, 1 signal bound, 1 dropped. 1 issue not in the file.",
	);
	expect((await dest.snapshot()).signals).toHaveLength(1);
});

it("refuses a member calling restore directly while the object still says admin", async () => {
	const dest = await destination();
	const issueId = "original";
	expect(
		await track.mutate(dest.id, dest.member, {
			name: "issue.create",
			args: {
				id: await importId("track:" + issueId),
				teamId: "destination",
				title: "Imported issue",
				sortOrder: "a0",
			},
		}),
	).toMatchObject({ ok: true });
	// Demote only in D1 to exercise the gateway before the object learns of the change.
	await track.db
		.prepare("update member set role = ? where organization_id = ? and user_id = ?")
		.bind("member", dest.id, dest.member.id)
		.run();
	const source = {
		id: "original-source",
		teamId: "destination",
		name: "Guard",
		product: "guard" as const,
		assigneeId: null,
		lowestSeverity: "high" as const,
		closeWhenCleared: false,
		linkOrigins: [],
	};
	expect(
		await dest.restore({
			exportedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
			source,
			signals: [
				{
					sourceId: source.id,
					issueId,
					key: "finding",
					state: "open",
					severity: "high",
					type: null,
					subject: null,
					url: null,
					reopens: 0,
					firstAt: 1,
					changedAt: 1,
				},
			],
		}),
	).toEqual({ ok: false, message: "Sources and signals need an owner or admin to import." });
	const snap = await dest.snapshot();
	expect(snap.sources).toEqual([]);
	expect(snap.signals).toEqual([]);
});

it("a webhook for an imported issue carries its signal at the event size boundary", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const event = {
		key: doc.signals[0].key,
		title: "x",
		severity: "high",
		state: "open",
		sentAt: "2000-01-01T00:00:00Z",
		subject: "",
	};
	const subject = "s".repeat(16384 - Buffer.byteLength(JSON.stringify(event)));
	doc.signals = [{ ...doc.signals[0], subject }];
	const dest = await destination();
	await dest.load(JSON.stringify(doc));
	const { signals, issues } = await dest.snapshot();
	const [signal] = signals;
	const issue = issues.find((i) => i.id === signal?.issueId);
	if (!signal || !issue || issue.archivedAt !== null) throw new Error("Missing imported issue");
	const url = "https://hooks.test/" + dest.id;
	expect(
		await track.rpc(
			dest.id,
			"createWebhook",
			dest.member,
			{ id: dest.id, slug: dest.id, origin },
			{ url, teamId: null, agentId: null, events: ["issue.updated"] },
		),
	).toMatchObject({ ok: true });
	expect(
		await track.mutate(dest.id, dest.member, {
			name: "issue.update",
			args: {
				id: signal.issueId,
				baseVersion: issue.version,
				patch: { title: "Changed" },
			},
		}),
	).toMatchObject({ ok: true });
	await vi.waitFor(() => expect(track.received.find((h) => h.url === url)).toBeDefined(), {
		timeout: 5000,
	});
	const hook = track.received.find((h) => h.url === url);
	expect(Buffer.byteLength(hook?.body ?? "")).toBeLessThan(64 * 1024);
	expect(JSON.parse(hook?.body ?? "{}")).toMatchObject({
		data: {
			issue: {
				id: signal.issueId,
				signal: { subject, key: signal.key, source: { id: signal.sourceId } },
			},
		},
	});
});

it("a lookup and a rotation from before deletion cannot write to a restored replacement", async () => {
	const { file } = await exportedWorkspace();
	const dest = await destination();
	await dest.load(file);
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw Error("Missing source");
	const id = source.id;
	const key = await dest.change({ kind: "makeKey", id });
	if (!key.value.secret) throw Error("Missing key");
	await dest.change({ kind: "pause", id, paused: false });
	const db = createDb(track.db as unknown as D1Database);
	const admitted = await findSourceByKey(db, key.value.secret);
	if (!admitted) throw Error("Gateway refused the key");
	const rotation = await applySourceAction(
		db,
		dest.id,
		async (command) => {
			const outcome = await track.rpc<ReturnType<WorkspaceDO["manageSource"]>>(
				dest.id,
				"manageSource",
				dest.member.id,
				command,
			);
			if (command.kind === "checkKey") {
				expect(await dest.change({ kind: "delete", id })).toMatchObject({ ok: true });
				await dest.load(file);
				expect(await dest.change({ kind: "pause", id, paused: false })).toMatchObject({ ok: true });
			}
			return outcome;
		},
		{ kind: "makeKey", id },
	);
	const body = JSON.stringify({
		key: "late",
		title: "Delayed",
		state: "open",
		severity: "high",
		sentAt: new Date().toISOString(),
	});
	expect
		.soft(await track.rpc(dest.id, "sourceEvent", admitted.sourceId, admitted.keyId, body, origin))
		.toMatchObject({ status: 404 });
	expect.soft(rotation.ok).toBe(false);
	expect(await sourceKeys(db, dest.id)).toEqual([]);
	expect((await dest.snapshot()).issues).toHaveLength(2);
});

it("keeps the first signal in file order across sources and skips a source with its team missing", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const [first] = doc.signals;
	doc.sources.push(
		{ ...doc.sources[0], id: "second" },
		{ ...doc.sources[0], id: "orphan", teamId: "absent" },
	);
	doc.signals.unshift({ ...first, sourceId: "second", key: "winner" });
	const dest = await destination();
	const answer = await dest.load(JSON.stringify(doc), true);
	expect(answer).toContain("1 issue already linked");
	expect(answer).toContain("team missing");
	const snap = await dest.snapshot();
	expect(snap.sources).toHaveLength(2);
	expect(snap.signals.filter((row) => row.key === first.key)).toEqual([]);
	expect(snap.signals).toHaveLength(2);
	expect(snap.signals.some((row) => row.key === "winner")).toBe(true);
});

it("drops an issue moved to another team even when importing into one team", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	doc.issues[0].teamId = "other";
	const dest = await destination();
	expect(await dest.load(JSON.stringify(doc))).toContain("1 issue in another team");
	expect((await dest.snapshot()).signals).toHaveLength(1);
});

it("a live source keeps its issue when another source is restored", async () => {
	const { file } = await exportedWorkspace();
	const dest = await destination();
	await dest.load(file);
	const before = await dest.snapshot();
	const [source] = before.sources;
	if (!source) throw Error("Missing source");
	expect(await dest.change({ kind: "pause", id: source.id, paused: false })).toMatchObject({
		ok: true,
	});
	const doc = JSON.parse(file);
	doc.sources[0].id = "second";
	for (const row of doc.signals) row.sourceId = "second";
	expect(await dest.load(JSON.stringify(doc))).toContain("2 issues already linked");
	expect((await dest.snapshot()).signals).toEqual(before.signals);
});

// Read the validation error from the server function without decoding it as a successful reply.
async function expectRestoreLimits(
	dest: Awaited<ReturnType<typeof destination>>,
	input: SourceRestore,
	reason: string,
) {
	const request = serverFunctions(
		origin,
		async (url, init) => {
			const response = await track.fetch(url, init);
			return new Response(await response.text(), { status: response.status });
		},
		freshAddress,
	);
	const response = await request(
		"restoreSource",
		"POST",
		{ workspace: dest.id, input },
		{ cookie: dest.member.cookie },
	);
	expect(response.text).toContain(reason);
	const id = await importId("track-source:" + input.source.id);
	expect(
		await track.rpc(dest.id, "restoreSource", dest.member.id, {
			exportedAt: input.exportedAt,
			source: { ...input.source, id, teamId: "destination" },
			signals: await Promise.all(
				input.signals.map(async (row) => ({
					...row,
					sourceId: id,
					issueId: row.issueId && (await importId("track:" + row.issueId)),
				})),
			),
		}),
	).toMatchObject({ ok: false, reason: "invalid" });
}

it("restores 2,000 of 2,001 signals and reports the excess", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const [issue] = doc.issues;
	const [signal] = doc.signals;
	doc.issues = Array.from({ length: 2001 }, (_, i) => ({
		...issue,
		id: "issue-" + i,
		number: i + 1,
	}));
	doc.signals = doc.issues.map((row: { id: string }) => ({
		...signal,
		issueId: row.id,
		key: row.id,
		state: "dismissed",
		changedAt: Date.now(),
	}));
	const dest = await destination();
	expect(await dest.load(JSON.stringify(doc))).toBe(
		"1 source restored, 0 already present, 2000 signals bound, 1 dropped. 1 over the limit.",
	);
	const snapshot = await dest.snapshot();
	expect(snapshot.signals).toHaveLength(2000);
	expect(snapshot.signals.some((row) => row.key === "issue-2000")).toBe(false);
	await expectRestoreLimits(
		dest,
		{ exportedAt: doc.exportedAt, source: doc.sources[0], signals: doc.signals },
		"too_big",
	);
	const [restored] = snapshot.sources;
	const [bound] = snapshot.signals;
	if (!restored || !bound) throw Error("Missing restored rows");
	// A repeat with a valid row count returns present before checking individual bindings.
	expect(
		await track.rpc(dest.id, "restoreSource", dest.member.id, {
			exportedAt: doc.exportedAt,
			source: restored,
			signals: Array(2001).fill(bound),
		}),
	).toMatchObject({ ok: false, reason: "invalid" });
}, 120_000);

it("checks the issue's current team in the object", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const dest = await destination();
	expect(await dest.load(JSON.stringify({ ...doc, sources: [], signals: [] }))).toBeUndefined();
	const source = { ...doc.sources[0], teamId: "destination" };
	expect(
		await track.mutate(dest.id, dest.member, {
			name: "team.create",
			args: { id: "another", name: "Another", key: "OTH" },
		}),
	).toMatchObject({ ok: true });
	expect(
		await dest.restore({
			exportedAt: doc.exportedAt,
			source: { ...source, teamId: "another" },
			signals: doc.signals,
		}),
	).toMatchObject({ ok: true, value: { dropped: 2, otherTeam: 2, bound: 0 } });
	expect((await dest.snapshot()).signals).toEqual([]);
});

it("continues both sender histories after a round trip and exports a saturated reopen count", async () => {
	const original = await setup();
	const clock = Date.now() - 20 * 60_000;
	const send = async (secret: string, key: string, state: "open" | "cleared", offset: number) => {
		const response = await track.fetch(origin + "/api/events", {
			method: "POST",
			headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
			body: JSON.stringify({
				key,
				state,
				title: key,
				severity: "high",
				sentAt: new Date(clock + offset).toISOString(),
			}),
		});
		expect(response.status).toBe(200);
		return ((await response.json()) as { state: string }).state;
	};
	expect(
		await original.apply({
			kind: "update",
			id: original.key.sourceId,
			input: { closeWhenCleared: true },
		}),
	).toMatchObject({ ok: true });
	for (const key of ["heartbeat", "reopen"])
		expect(await send(original.initial, key, "open", 0)).toBe("open");
	expect(await send(original.initial, "reopen", "cleared", 1)).toBe("cleared");
	const toJson = (snapshot: Snapshot) =>
		workspaceToJson(
			{ ...snapshot, workspace: { slug: "history", name: "History" } },
			null,
			new Date(clock + 2),
		);
	const doc = JSON.parse(
		toJson(await track.rpc<Snapshot>(original.id, "snapshot", original.owner)),
	);
	for (const signal of doc.signals) if (signal.key === "reopen") signal.reopens = 1_000_000;
	const dest = await destination();
	await dest.load(JSON.stringify(doc));
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw Error("Missing restored source");
	const { value } = await dest.change({ kind: "makeKey", id: source.id });
	if (!value.secret) throw Error("No new key");
	expect(await dest.change({ kind: "pause", id: source.id, paused: false })).toMatchObject({
		ok: true,
	});
	// Sent after the export and the clock skew, in both workspaces.
	const later = Date.now() - 1000 - clock;
	for (const secret of [original.initial, value.secret]) {
		expect(await send(secret, "heartbeat", "open", later + 3)).toBe("open");
		expect(await send(secret, "heartbeat", "cleared", later + 2)).toBe("open");
		expect(await send(secret, "heartbeat", "cleared", later + 4)).toBe("cleared");
		expect(await send(secret, "reopen", "open", later + 2)).toBe("open");
	}
	expect(JSON.parse(toJson(await dest.snapshot())).signals).toContainEqual(
		expect.objectContaining({ key: "reopen", state: "open", reopens: 1_000_000 }),
	);
});

it("a delayed removal preserves the replacement generation's working key", async () => {
	const { file } = await exportedWorkspace();
	const dest = await destination();
	await dest.load(file);
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw Error("Missing restored source");
	const { id } = source;
	const original = await dest.change({ kind: "makeKey", id });
	if (!original.value.secret) throw Error("Missing original key");
	const other = await addAdmin(dest.id, crypto.randomUUID());
	let secret = "";
	const delayed = await applySourceAction(
		createDb(track.db as unknown as D1Database),
		dest.id,
		async (command) => {
			const result = await track.rpc<ReturnType<WorkspaceDO["manageSource"]>>(
				dest.id,
				"manageSource",
				other.id,
				command,
			);
			if (command.kind === "prepareRemoval") {
				expect(result.ok).toBe(true);
				expect(await dest.change({ kind: "delete", id })).toMatchObject({ ok: true });
				await dest.load(file);
				const made = await dest.change({ kind: "makeKey", id });
				if (!made.value.secret) throw Error("Missing replacement key");
				secret = made.value.secret;
				expect(await dest.change({ kind: "pause", id, paused: false })).toMatchObject({ ok: true });
				expect((await report(secret, "first")).status).toBe(200);
				expect(
					await track.rpc(dest.id, "manageSource", dest.member.id, { kind: "prepareRemoval", id }),
				).toMatchObject({ ok: true });
			}
			return result;
		},
		{ kind: "delete", id },
	);
	expect(delayed.ok).toBe(false);
	expect((await report(original.value.secret, "second")).status).toBe(404);
	expect((await report(secret, "second")).status).toBe(503);
});

it("a stale first clear on a restored signal leaves its issue unchanged", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	doc.sources[0].closeWhenCleared = true;
	doc.issues[0].status = "in_progress";
	const dest = await destination();
	await dest.load(JSON.stringify(doc));
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw Error("Missing source");
	const made = await dest.change({ kind: "makeKey", id: source.id });
	if (!made.value.secret) throw Error("Missing key");
	expect(await dest.change({ kind: "pause", id: source.id, paused: false })).toMatchObject({
		ok: true,
	});
	for (const signal of doc.signals) {
		const response = await track.fetch(origin + "/api/events", {
			method: "POST",
			headers: { authorization: "Bearer " + made.value.secret },
			body: JSON.stringify({
				key: signal.key,
				state: "cleared",
				severity: "high",
				title: "Clear",
				sentAt: "2000-01-01T00:00:00Z",
			}),
		});
		expect(await response.json()).toMatchObject({ state: "open" });
	}
	const snapshot = await dest.snapshot();
	for (const issue of doc.issues) {
		const id = await importId("track:" + issue.id);
		expect(snapshot.issues.find((row) => row.id === id)?.status).toBe(issue.status);
	}
});

it("replaying a pre-export open with a new key leaves the restored signal cleared", async () => {
	const original = await setup();
	const at = Date.now() - 10 * 60_000;
	const send = (secret: string, state: "open" | "cleared", time: number) =>
		track.fetch(origin + "/api/events", {
			method: "POST",
			headers: { authorization: "Bearer " + secret },
			body: JSON.stringify({
				key: "queued",
				title: "Queued",
				severity: "high",
				state,
				sentAt: new Date(time).toISOString(),
			}),
		});
	expect(await (await send(original.initial, "open", at)).json()).toMatchObject({ state: "open" });
	expect(await (await send(original.initial, "cleared", at + 1000)).json()).toMatchObject({
		state: "cleared",
	});
	const snap = await track.rpc<Snapshot>(original.id, "snapshot", original.owner);
	const dest = await destination();
	await dest.load(
		workspaceToJson(
			{ ...snap, workspace: { slug: "from", name: "From" } },
			null,
			new Date(at + 2000),
		),
	);
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw Error("Missing source");
	const made = await dest.change({ kind: "makeKey", id: source.id });
	if (!made.value.secret) throw Error("Missing key");
	expect(await dest.change({ kind: "pause", id: source.id, paused: false })).toMatchObject({
		ok: true,
	});
	expect(await (await send(made.value.secret, "open", at)).json()).toMatchObject({
		state: "cleared",
	});
	expect((await dest.snapshot()).signals[0]?.state).toBe("cleared");
	expect(await (await send(made.value.secret, "open", Date.now())).json()).toMatchObject({
		state: "open",
	});
	expect((await dest.snapshot()).signals[0]?.state).toBe("open");
});

it("restores an exported event with a 16,220-byte subject", async () => {
	const original = await setup();
	const subject = "a".repeat(16220);
	const response = await track.fetch(origin + "/api/events", {
		method: "POST",
		headers: { authorization: "Bearer " + original.initial },
		body: JSON.stringify({
			key: "k",
			state: "open",
			severity: "high",
			title: "T",
			sentAt: new Date().toISOString(),
			subject,
		}),
	});
	expect(response.status).toBe(200);
	const snapshot = await track.rpc<Snapshot>(original.id, "snapshot", original.owner);
	const dest = await destination();
	expect(
		await dest.load(workspaceToJson({ ...snapshot, workspace: { name: "From", slug: "from" } })),
	).toContain("1 signal bound, 0 dropped");
	expect((await dest.snapshot()).signals[0]?.subject).toBe(subject);
});

it("an interrupted import restores sources after an archived comment already exists", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const archived = doc.issues.pop();
	doc.archivedIssues = [{ ...archived, status: "done" }];
	doc.comments = [
		{
			id: "reply",
			issueId: archived.id,
			body: "Imported reply",
			authorId: "author",
			createdAt: archived.createdAt,
		},
	];
	const dest = await destination();
	await dest.load(JSON.stringify({ ...doc, sources: [], signals: [] }));
	const id = await importId("track:" + archived.id);
	expect((await dest.snapshot()).issues.find((row) => row.id === id)?.archivedAt).toEqual(
		expect.any(Number),
	);
	expect(await dest.load(JSON.stringify(doc), false, ["Comment id already exists"])).toContain(
		"1 source restored, 0 already present, 2 signals bound",
	);
});

it("a duplicate issue id across teams is ambiguous", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const issue = doc.issues[0];
	doc.teams.push({ ...doc.teams[0], id: "other", key: "OTH" });
	doc.issues = [issue, { ...issue, teamId: "other" }];
	doc.signals = doc.signals.filter((row: { issueId: string }) => row.issueId === issue.id);
	const dest = await destination();
	expect(await dest.load(JSON.stringify(doc))).toContain("issue id repeated in the file");
	expect((await dest.snapshot()).signals).toEqual([]);
});

it("an invalid team key skips its source when keeping teams", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	doc.teams[0].key = "NO SPACE";
	const dest = await destination();
	expect(await dest.load(JSON.stringify(doc), true)).toContain("1 source skipped (team missing)");
	expect((await dest.snapshot()).sources).toEqual([]);
});

it("bounds a restore of 1,600 non-Latin-1 signals by bytes and counts the excess", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const [issue] = doc.issues;
	const [signal] = doc.signals;
	const subject = "界".repeat(4000);
	doc.issues = Array.from({ length: 1600 }, (_, i) => ({ ...issue, id: "i" + i, number: i + 1 }));
	doc.signals = doc.issues.map((row: { id: string }) => ({
		...signal,
		key: row.id,
		issueId: row.id,
		state: "dismissed",
		subject,
	}));
	const dest = await destination();
	const result = await dest.load(JSON.stringify(doc));
	const snapshot = await dest.snapshot();
	await expectRestoreLimits(
		dest,
		{ exportedAt: doc.exportedAt, source: doc.sources[0], signals: doc.signals },
		"Signals exceed the restore byte limit",
	);
	const bound = snapshot.signals.length;
	expect(bound).toBeGreaterThan(0);
	expect(bound).toBeLessThan(1600);
	const rpcRows = snapshot.signals.map(({ id: _, ...row }) => row);
	const size = Buffer.byteLength(JSON.stringify(rpcRows));
	expect(size).toBeLessThanOrEqual(8 * 1024 * 1024);
	expect(size + Buffer.byteLength(JSON.stringify(rpcRows.at(-1)))).toBeGreaterThan(8 * 1024 * 1024);
	expect(result).toBe(
		`1 source restored, 0 already present, ${bound} signals bound, ${1600 - bound} dropped. ${1600 - bound} over the limit.`,
	);
}, 120_000);

it("drops a signal when two file ids encode to the same issue id", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const issue = doc.issues[0];
	doc.issues = [
		{ ...issue, id: "\ud800" },
		{ ...issue, id: "\ufffd" },
	];
	doc.signals = [{ ...doc.signals[0], issueId: "\ufffd" }];
	const row = readJsonImport(JSON.stringify(doc)).source.sources?.[0];
	expect(row).toMatchObject({ signals: [], drops: { repeatedIssue: 1 } });
	const dest = await destination();
	expect(await dest.load(JSON.stringify(doc), false, [], ["1 repeated issue skipped."])).toContain(
		"1 dropped (issue id repeated in the file)",
	);
});

it("exports and edits a legacy source with 1000 origins and counts it as settings too large on restore", async () => {
	const dest = await destination();
	const linkOrigins = Array.from({ length: 1000 }, (_, i) => `https://reports${i}.example`);
	expect(
		await dest.change({
			kind: "create",
			input: { name: "Legacy", product: "guard", teamId: "destination", linkOrigins },
		}),
	).toMatchObject({ ok: true });
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw Error("Missing legacy source");
	expect(
		await dest.change({ kind: "update", id: source.id, input: { name: "Renamed" } }),
	).toMatchObject({ ok: true });
	const file = workspaceToJson({
		...(await dest.snapshot()),
		workspace: { slug: "from", name: "From" },
	});
	expect(JSON.parse(file).sources[0]).toMatchObject({ name: "Renamed", linkOrigins });
	const other = await destination();
	expect(await other.load(file)).toContain("1 skipped (settings too large)");
	expect((await other.snapshot()).sources).toEqual([]);
});

it("round trips a stored percent-encoded CJK URL", async () => {
	const dest = await destination();
	const made = await dest.change({
		kind: "create",
		input: {
			name: "Reports",
			product: "guard",
			teamId: "destination",
			linkOrigins: ["https://reports.example"],
		},
	});
	const url = "https://reports.example/" + "界".repeat(3000);
	const response = await track.fetch(origin + "/api/events", {
		method: "POST",
		headers: { authorization: "Bearer " + made.value.secret },
		body: JSON.stringify({
			title: "T",
			key: "finding",
			state: "open",
			severity: "high",
			sentAt: new Date().toISOString(),
			url,
		}),
	});
	expect(response.status).toBe(200);
	const file = workspaceToJson({
		...(await dest.snapshot()),
		workspace: { slug: "from", name: "From" },
	});
	const other = await destination();
	expect(await other.load(file)).toContain("1 signal bound, 0 dropped");
	expect((await other.snapshot()).signals[0]?.url).toBe(new URL(url).href);
});

it("counts invalid signals and restores the largest key an event can address", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	const event = {
		key: "",
		title: "x",
		severity: "low",
		state: "open",
		sentAt: "2000-01-01T00:00:00Z",
	};
	event.key = "k".repeat(16384 - Buffer.byteLength(JSON.stringify(event)));
	const [one, two] = doc.signals;
	doc.signals = [
		{ ...one, key: "a".repeat(16330) },
		{ ...one, severity: "invalid" },
		{ ...one, subject: "a".repeat(70_000) },
		{ ...one, subject: "a".repeat(2_200_000) },
		{ ...two, key: event.key, severity: event.severity },
	];
	const dest = await destination();
	expect(await dest.load(JSON.stringify(doc))).toContain(
		"1 signal bound, 4 dropped. 4 invalid signals.",
	);
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw Error("Missing restored source");
	expect((await dest.snapshot()).signals[0]?.key).toBe(event.key);
	const made = await dest.change({ kind: "makeKey", id: source.id });
	await dest.change({ kind: "pause", id: source.id, paused: false });
	expect(
		(
			await track.fetch(origin + "/api/events", {
				method: "POST",
				headers: { authorization: "Bearer " + made.value.secret },
				body: JSON.stringify(event),
			})
		).status,
	).toBe(200);
});

it("submits both repeated comments and restores the source after one is refused", async () => {
	const { file } = await exportedWorkspace();
	const doc = JSON.parse(file);
	doc.comments = [...doc.issues].reverse().map((row: { id: string }) => ({
		id: "reply",
		issueId: row.id,
		body: "Reply",
		authorId: "author",
	}));
	const dest = await destination();
	expect(await dest.load(JSON.stringify(doc), false, ["Comment id already exists"])).toContain(
		"2 signals bound",
	);
	const comments = (await dest.snapshot()).comments;
	expect(comments).toHaveLength(1);
	expect(comments[0]?.issueId).toBe(await importId("track:" + doc.issues[0].id));
});

it("a stale generation row leaves room to make and rotate two replacement keys", async () => {
	const { file } = await exportedWorkspace();
	const dest = await destination();
	await dest.load(file);
	const [source] = (await dest.snapshot()).sources;
	if (!source) throw Error("Missing restored source");
	const id = source.id;
	await dest.change({ kind: "makeKey", id });
	const db = createDb(track.db as unknown as D1Database);
	const [old] = await sourceKeys(db, dest.id);
	if (!old) throw Error("Missing key");
	await dest.change({ kind: "delete", id });
	await dest.load(file);
	await track.db
		.prepare("insert into source_key(id,organization_id,source_id,hash,start) values(?,?,?,?,?)")
		.bind(old.id, dest.id, id, crypto.randomUUID(), old.start)
		.run();
	expect(
		(await serverFn("getSourceSettings", "GET", dest.id, { cookie: dest.member.cookie })).result,
	).toMatchObject({ keys: [{ ...old, stale: true }] });
	for (let i = 0; i < 2; i++)
		expect(await dest.change({ kind: "makeKey", id })).toMatchObject({ ok: true });
	const keys = await sourceKeys(db, dest.id);
	expect(keys.map((k) => k.id)).not.toContain(old.id);
	expect(keys).toHaveLength(2);
	expect(await dest.change({ kind: "revokeKey", id, keyId: keys[0]?.id ?? "" })).toMatchObject({
		ok: true,
	});
	expect(await dest.change({ kind: "makeKey", id })).toMatchObject({ ok: true });
});
