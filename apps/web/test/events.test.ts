import { createHash, randomBytes } from "node:crypto";
import {
	BAD_KEYS_PER_ADDRESS,
	CALLS_PER_MINUTE,
	EVENT_MAX_BYTES,
	type Source,
} from "@gateweave/track-protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb } from "../src/server/db";
import { faulty } from "../src/server/db/faulty-d1";
import { findSourceByKey } from "../src/server/source-keys";
import { startTrack } from "./track-worker";

const origin = "https://track.test";
const endpoint = `${origin}/api/events`;
const slug = "event-workspace";
const owner = {
	id: "owner",
	name: "Owner",
	role: "owner",
	email: "owner@test.invalid",
	image: null,
};
const secret = `gws_${randomBytes(32).toString("base64url")}`;
const settings = {
	name: "Guard test",
	product: "guard",
	teamId: "team-test",
	lowestSeverity: "high",
	closeWhenCleared: false,
	linkOrigins: [],
};
const event = {
	key: "finding",
	state: "open",
	sentAt: "2026-11-18T10:00:00Z",
	severity: "high",
	title: "TLS certificate",
};
let track: Awaited<ReturnType<typeof startTrack>>;
let source: Source;
beforeAll(async () => {
	track = await startTrack(origin, { isolates: 2, isolateVars: [{}, { TRACK_DEMO: "1" }] });
	await track.db
		.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES (?,?,?,?)")
		.bind(slug, slug, slug, 0)
		.run();
	expect(
		(
			await track.mutate(slug, owner, {
				name: "team.create",
				args: { id: settings.teamId, name: "Engineering", key: "ENG" },
			})
		).ok,
	).toBe(true);
	const result = await track.rpc<{ ok: boolean; value: Source }>(slug, "manageSource", owner.id, {
		kind: "create",
		input: settings,
	});
	expect(result.ok).toBe(true);
	source = result.value;
	await track.db
		.prepare("INSERT INTO source_key (id,source_id,organization_id,hash,start) VALUES (?,?,?,?,?)")
		.bind(
			"key-1",
			source.id,
			slug,
			createHash("sha256").update(secret).digest("hex"),
			secret.slice(0, 12),
		)
		.run();
});
afterAll(async () => {
	await track?.dispose();
});

function send(key: string | null, body: string, address = "192.0.2.10") {
	return track.fetch(endpoint, {
		method: "POST",
		headers: {
			...(key && { authorization: `Bearer ${key}` }),
			"cf-connecting-ip": address,
			"content-type": "application/json",
		},
		body,
	});
}

it("R1: only a POST bearer credential admits an event", async () => {
	const cookie = await track.fetch(endpoint, {
		method: "POST",
		headers: { cookie: `authorization=Bearer ${secret}; key=${secret}` },
		body: JSON.stringify(event),
	});
	expect(cookie.status).toBe(404);
	expect(
		(await track.fetch(endpoint, { headers: { authorization: `Bearer ${secret}` } })).status,
	).toBe(405);
	const response = await send(secret, JSON.stringify(event));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		state: "open",
		filed: true,
		issue: { key: "ENG-1", url: `${origin}/${slug}/issue/ENG-1` },
	});
});

it("R2: one indexed lookup of the hash identifies the workspace and source", async () => {
	const watched = faulty(track.db as unknown as D1Database);
	const database = createDb(watched.database);
	for (const credential of [secret, null, "malformed"]) {
		watched.state.sent.length = 0;
		const found = await findSourceByKey(database, credential);
		if (credential === secret)
			expect(found).toEqual({
				keyId: "key-1",
				workspaceId: slug,
				slug,
				sourceId: source.id,
				jurisdiction: null,
			});
		else expect(found).toBeNull();
		expect(watched.state.sent).toHaveLength(1);
		expect(watched.state.sent[0]).toContain("source_key");
		expect(watched.state.sent[0]).not.toContain(secret);
	}
});

it("R2: an unknown key is refused before an oversized or malformed body is parsed", async () => {
	for (const raw of ["{", "x".repeat(EVENT_MAX_BYTES + 1)]) {
		expect((await send(`gws_${"x".repeat(43)}`, raw)).status).toBe(404);
		expect((await send(secret, raw)).status).toBe(400);
	}
});

it("R3: missing, malformed, unknown and revoked keys share a refusal and an address budget", async () => {
	const revoked = `gws_${randomBytes(32).toString("base64url")}`;
	await track.db
		.prepare("INSERT INTO source_key (id,source_id,organization_id,hash,start) VALUES (?,?,?,?,?)")
		.bind(
			"revoked",
			source.id,
			slug,
			createHash("sha256").update(revoked).digest("hex"),
			revoked.slice(0, 12),
		)
		.run();
	await track.db.prepare("DELETE FROM source_key WHERE id = ?").bind("revoked").run();
	const keys = [null, "bad", `gws_${"b".repeat(43)}`, revoked];
	for (let i = 0; i <= BAD_KEYS_PER_ADDRESS.hour; i++) {
		const response = await send(keys[i % keys.length] ?? null, "{}", "192.0.2.31");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
		expect(response.headers.has("retry-after")).toBe(i === BAD_KEYS_PER_ADDRESS.hour);
	}
});

it("R5: an existing D1 key cannot write while its source is paused or missing", async () => {
	await track.rpc(slug, "manageSource", owner.id, { kind: "pause", id: source.id, paused: true });
	try {
		expect((await send(secret, "{")).status).toBe(404);
		await track.db
			.prepare("UPDATE source_key SET source_id=? WHERE id=?")
			.bind("missing", "key-1")
			.run();
		expect((await send(secret, JSON.stringify(event))).status).toBe(404);
	} finally {
		await track.db
			.prepare("UPDATE source_key SET source_id=? WHERE id=?")
			.bind(source.id, "key-1")
			.run();
		await track.rpc(slug, "manageSource", owner.id, {
			kind: "pause",
			id: source.id,
			paused: false,
		});
	}
});

it("R3: paused and missing sources spend the bad-key address allowance and return the same body", async () => {
	const address = "192.0.2.73";
	const bad = await send("bad", "{}", address);
	const body = await bad.text();
	await track.rpc(slug, "manageSource", owner.id, { kind: "pause", id: source.id, paused: true });
	try {
		for (let i = 1; i <= BAD_KEYS_PER_ADDRESS.hour; i++) {
			if (i === 2)
				await track.db
					.prepare("UPDATE source_key SET source_id=? WHERE id=?")
					.bind("missing", "key-1")
					.run();
			const response = await send(secret, "{}", address);
			expect(response.status).toBe(404);
			expect(await response.text()).toBe(body);
			expect(response.headers.has("retry-after")).toBe(i === BAD_KEYS_PER_ADDRESS.hour);
		}
	} finally {
		await track.db
			.prepare("UPDATE source_key SET source_id=? WHERE id=?")
			.bind(source.id, "key-1")
			.run();
		await track.rpc(slug, "manageSource", owner.id, {
			kind: "pause",
			id: source.id,
			paused: false,
		});
	}
});

it("R6: a demo isolate refuses even a key and source that exist", async () => {
	const response = await track.fetchIn(1, endpoint, {
		method: "POST",
		headers: { authorization: `Bearer ${secret}` },
		body: JSON.stringify(event),
	});
	expect(response.status).toBe(404);
});

it("R7: the Worker rejects unknown fields, oversized bodies and invalid event values", async () => {
	const invalidUtf8 = Buffer.from(JSON.stringify({ ...event, title: "BAD" }));
	invalidUtf8[invalidUtf8.indexOf("BAD")] = 0xff;
	expect(
		(
			await track.fetch(endpoint, {
				method: "POST",
				headers: { authorization: `Bearer ${secret}` },
				body: new Uint8Array(invalidUtf8),
			})
		).status,
	).toBe(400);
	for (const patch of [
		{ state: "resolved" },
		{ severity: "info" },
		{ sentAt: "yesterday" },
		{ kind: "run" },
		{ body: "x".repeat(4001) },
	]) {
		expect((await send(secret, JSON.stringify({ ...event, ...patch }))).status).toBe(400);
	}
	expect(
		(await send(secret, JSON.stringify({ ...event, key: "x".repeat(EVENT_MAX_BYTES) }))).status,
	).toBe(400);
});

it("R28: the gateway returns 429 with Retry-After when a source exhausts its minute", async () => {
	let response = await send(secret, JSON.stringify(event));
	for (let i = 0; i < CALLS_PER_MINUTE && response.ok; i++) {
		response = await send(secret, JSON.stringify(event));
	}
	expect(response.status).toBe(429);
	expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
});
