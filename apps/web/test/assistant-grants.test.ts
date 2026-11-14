import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	Client,
	type OAuthClientInformationMixed,
	type OAuthClientProvider,
	type OAuthTokens,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Taking an AI assistant's access back, through the built Worker: the account page's server
// functions, `/mcp`, the token endpoint and the daily cron, against real OAuth grants.

const origin = "https://track.test";
const redirectUrl = "http://127.0.0.1:47199/callback";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

/** The URL the built app serves a server function at, found by its name in the build's manifest. */
function serverFnUrl(name: string) {
	const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
	const pattern = new RegExp(
		`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
	);
	for (const file of readdirSync(assets).filter((f) =>
		f.startsWith("__23tanstack-start-server-fn"),
	)) {
		const match = pattern.exec(readFileSync(join(assets, file), "utf8"));
		if (match) return `${origin}/_serverFn/${match[1]}`;
	}
	throw new Error(`Could not find ${name} in the build`);
}

/** Reads the plain values (objects, arrays, strings, numbers, booleans, null) of Seroval's JSON. */
function decode(node: unknown): unknown {
	const { t, s, a, p } = node as {
		t: number;
		s?: unknown;
		a?: unknown[];
		p?: { k: string[]; v: unknown[] };
	};
	switch (t) {
		case 0:
		case 1:
			return s;
		case 2:
			return [null, undefined, true, false][s as number];
		case 9:
			return (a ?? []).map(decode);
		case 10:
			return Object.fromEntries((p?.k ?? []).map((key, i) => [key, decode(p?.v[i])]));
		default:
			throw new Error(`Unexpected node type ${t}`);
	}
}

interface Grant {
	clientId: string;
	name: string | null;
	goesTo: string;
	allowedAt: number;
	lastUsedAt: number | null;
}

/** Calls a server function as the browser does and returns what it answered. */
async function serverFn(name: string, cookie: string, data?: string) {
	const post = data !== undefined;
	const body = {
		t: {
			t: 10,
			i: 0,
			p: {
				k: ["data", "context"],
				v: [
					{ t: 1, s: data },
					{ t: 10, i: 1, p: { k: [], v: [] }, o: 0 },
				],
			},
			o: 0,
		},
		f: 0,
		m: [],
	};
	const response = await track.fetch(serverFnUrl(name), {
		method: post ? "POST" : "GET",
		headers: {
			cookie,
			origin,
			"x-tsr-serverFn": "true",
			accept: "application/json",
			...(post && { "content-type": "application/json" }),
		},
		...(post && { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	const { result } = decode(JSON.parse(text)) as { result: unknown };
	return { text, result };
}

const grantsOf = async (cookie: string) =>
	(await serverFn("getAssistantGrants", cookie)).result as Grant[];
const takeBack = async (cookie: string, clientId: string) =>
	((await serverFn("takeBackAssistant", cookie, clientId)).result as { ok: boolean }).ok;

let calls = 0;

async function authApi(path: string, cookie: string | null, body: object) {
	const response = await track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			// Each call from its own address, so no limit on one address gets in the way.
			"cf-connecting-ip": `203.0.113.${++calls}`,
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response;
}

async function signUp(name: string, email: string) {
	const response = await authApi("/sign-up/email", null, {
		name,
		email,
		password: "a-long-test-password",
	});
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

class MemoryProvider implements OAuthClientProvider {
	client: OAuthClientInformationMixed | undefined;
	savedTokens: OAuthTokens | undefined;
	verifier = "";
	authorizationUrl: URL | undefined;
	readonly #name: string;

	constructor(name: string) {
		this.#name = name;
	}
	get redirectUrl() {
		return redirectUrl;
	}
	get clientMetadata() {
		return {
			client_name: this.#name,
			redirect_uris: [redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}
	clientInformation() {
		return this.client;
	}
	saveClientInformation(client: OAuthClientInformationMixed) {
		this.client = client;
	}
	tokens() {
		return this.savedTokens;
	}
	saveTokens(tokens: OAuthTokens) {
		this.savedTokens = tokens;
	}
	saveCodeVerifier(verifier: string) {
		this.verifier = verifier;
	}
	codeVerifier() {
		return this.verifier;
	}
	redirectToAuthorization(url: URL) {
		this.authorizationUrl = url;
	}
	get clientId() {
		const id = this.client?.client_id;
		if (!id) throw new Error("Not registered yet");
		return id;
	}
}

const transport = (provider: MemoryProvider) =>
	new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
		authProvider: provider,
		fetch: track.fetch,
	});

/** An app that registers itself, as an agent does. Nobody has allowed it yet. */
async function register(name: string) {
	const provider = new MemoryProvider(name);
	const client = new Client({ name, version: "1.0.0" });
	await expect(client.connect(transport(provider))).rejects.toBeInstanceOf(UnauthorizedError);
	return provider;
}

/** The person allows the app on the consent page, and the app redeems its code for tokens. */
async function allow(provider: MemoryProvider, cookie: string) {
	const authorize = provider.authorizationUrl;
	if (!authorize) throw new Error("The app was never sent to authorize");
	const toConsent = await track.fetch(authorize, { headers: { cookie } });
	const consent = new URL(((await toConsent.json()) as { url: string }).url, origin);
	const decision = await authApi("/oauth2/consent", cookie, {
		accept: true,
		oauth_query: consent.search.slice(1),
	});
	const callback = new URL(((await decision.json()) as { url: string }).url);
	await transport(provider).finishAuth(callback.searchParams);
	const { access_token, refresh_token } = provider.savedTokens ?? {};
	if (!access_token || !refresh_token) throw new Error("The app got no tokens");
	return { access: access_token, refresh: refresh_token };
}

/** What `/mcp` answers a token: its status, and the challenge when it is turned away. */
async function callMcp(token: string) {
	const response = await track.fetch(`${origin}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
	return { status: response.status, challenge: response.headers.get("www-authenticate") ?? "" };
}

/** An app trading a refresh token for new tokens at the token endpoint. */
async function refreshGrant(clientId: string, refreshToken: string) {
	const response = await track.fetch(`${origin}/api/auth/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", origin },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			refresh_token: refreshToken,
			resource: `${origin}/mcp`,
		}),
	});
	const body = (await response.json()) as { refresh_token?: string };
	return { status: response.status, refresh: body.refresh_token };
}

async function count(table: string) {
	const row = await track.db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
	return row?.n ?? 0;
}

describe("taking an assistant's access back", () => {
	it("lists what a person allowed, ends it at once, and touches nobody else's", async () => {
		const maya = await signUp("Maya Chen", "maya.grants@example.com");
		const ben = await signUp("Ben Okafor", "ben.grants@example.com");

		const coder = await register("Coder");
		const writer = await register("Writer");
		const mayaCoder = await allow(coder, maya);
		const mayaWriter = await allow(writer, maya);
		// A client is registered once, and a second person can allow the same one.
		const benCoder = await allow(coder, ben);

		// Named by the app, going to an app on this computer, not used yet, and no token in sight.
		const listed = await serverFn("getAssistantGrants", maya);
		const grants = listed.result as Grant[];
		const byName = [...grants].sort((a, b) => String(a.name).localeCompare(String(b.name)));
		expect(byName.map(({ name, goesTo, lastUsedAt }) => ({ name, goesTo, lastUsedAt }))).toEqual([
			{ name: "Coder", goesTo: "an app on this computer", lastUsedAt: null },
			{ name: "Writer", goesTo: "an app on this computer", lastUsedAt: null },
		]);
		for (const grant of grants) {
			expect(grant.allowedAt).toBeGreaterThan(Date.now() - 60_000);
			expect(Object.keys(grant).sort()).toEqual([
				"allowedAt",
				"clientId",
				"goesTo",
				"lastUsedAt",
				"name",
			]);
		}
		const stored = await track.db
			.prepare(
				"SELECT id, token FROM oauth_refresh_token UNION SELECT id, token FROM oauth_access_token",
			)
			.all<{ id: string; token: string }>();
		const rows = stored.results as { id: string; token: string }[];
		const secrets = rows.flatMap(({ id, token }) => [id, token]);
		for (const t of [mayaCoder, mayaWriter, benCoder]) secrets.push(t.access, t.refresh);
		expect(secrets.length).toBeGreaterThan(6);
		for (const secret of secrets) expect(listed.text).not.toContain(secret);
		expect(listed.text).not.toContain("Ben");

		// A refresh is a use.
		const refreshed = await refreshGrant(coder.clientId, mayaCoder.refresh);
		expect(refreshed.status).toBe(200);
		const used = await grantsOf(maya);
		expect(used.find((g) => g.name === "Coder")?.lastUsedAt).toBeGreaterThan(Date.now() - 60_000);
		expect(used.find((g) => g.name === "Writer")?.lastUsedAt).toBeNull();
		// Most recently used first.
		expect(used[0]?.name).toBe("Coder");

		for (const token of [mayaCoder.access, mayaWriter.access, benCoder.access]) {
			expect((await callMcp(token)).status).toBe(200);
		}

		// A grant that is not yours, and one that does not exist, are the same "not found", and
		// nothing is deleted.
		const before = {
			consents: await count("oauth_consent"),
			refresh: await count("oauth_refresh_token"),
			access: await count("oauth_access_token"),
		};
		expect(await takeBack(ben, writer.clientId)).toBe(false);
		expect(await takeBack(ben, "no-such-client")).toBe(false);
		expect({
			consents: await count("oauth_consent"),
			refresh: await count("oauth_refresh_token"),
			access: await count("oauth_access_token"),
		}).toEqual(before);
		expect((await callMcp(mayaWriter.access)).status).toBe(200);

		// Maya takes Coder back. Her token has not expired, and is turned away at once with the
		// challenge that sends the app to ask her again.
		expect(await takeBack(maya, coder.clientId)).toBe(true);
		const turnedAway = await callMcp(mayaCoder.access);
		expect(turnedAway.status).toBe(401);
		// Exactly what a token that was never valid gets.
		expect(turnedAway.challenge).toContain("resource_metadata=");
		expect(turnedAway.challenge).toBe((await callMcp("not.a.token")).challenge);
		// It cannot refresh, with the token it started with or the one it got last.
		for (const refresh of [mayaCoder.refresh, refreshed.refresh ?? ""]) {
			expect((await refreshGrant(coder.clientId, refresh)).status).toBeGreaterThanOrEqual(400);
		}
		expect((await grantsOf(maya)).map((g) => g.name)).toEqual(["Writer"]);
		// Her other app, and Ben's grant of the very same client, keep working.
		expect((await callMcp(mayaWriter.access)).status).toBe(200);
		expect((await callMcp(benCoder.access)).status).toBe(200);
		expect((await refreshGrant(coder.clientId, benCoder.refresh)).status).toBe(200);
		expect((await grantsOf(ben)).map((g) => g.name)).toEqual(["Coder"]);

		// Taking it back twice deletes nothing more.
		expect(await takeBack(maya, coder.clientId)).toBe(false);
	});

	it("leaves an agent member's key as it was", async () => {
		const cookie = await signUp("Dana Ruiz", "dana.grants@example.com");
		const created = await authApi("/organization/create", cookie, {
			name: "Grants Co",
			slug: "grants-co",
		});
		const { id: organizationId } = (await created.json()) as { id: string };
		const agent = await authApi("/agents/create", cookie, { organizationId, name: "Triage" });
		const { key } = (await agent.json()) as { key: string };
		const app = await register("Helper");
		const tokens = await allow(app, cookie);
		expect((await callMcp(key)).status).toBe(200);

		// The person's own grant goes, and the agent member's key does not: it has its own revoke
		// in the workspace's settings.
		expect(await takeBack(cookie, app.clientId)).toBe(true);
		expect((await callMcp(tokens.access)).status).toBe(401);
		expect((await callMcp(key)).status).toBe(200);
	});

	it("deletes an app nobody allowed once it is old, and keeps the rest", async () => {
		const person = await signUp("Lena Park", "lena.grants@example.com");
		const kept = await register("Kept");
		await allow(kept, person);
		const waiting = await register("Waiting");
		const old = Date.now() - 2 * 24 * 3_600_000;
		const lena = "(SELECT id FROM user WHERE email = 'lena.grants@example.com')";
		const client = (id: string, owner: string) =>
			track.db
				.prepare(
					`INSERT INTO oauth_client (id, client_id, user_id, redirect_uris, created_at, updated_at) VALUES (?1, ?1, ${owner}, '[]', ?2, ?2)`,
				)
				.bind(id, old);
		await track.db.batch([
			client("old-unused", "NULL"),
			// Registered long ago, but a refresh token of it still works.
			client("old-refreshing", "NULL"),
			// Someone registered it signed in, which dynamic registration never does.
			client("old-owned", lena),
		]);
		await track.db
			.prepare(
				`INSERT INTO oauth_refresh_token (id, token, client_id, user_id, scopes, expires_at, created_at) VALUES ('keeps-it', 'keeps-it', 'old-refreshing', ${lena}, '[]', ?1, ?2)`,
			)
			.bind(Date.now() + 3_600_000, old)
			.run();

		await track.runScheduled();

		const has = async (clientId: string) =>
			(await track.db
				.prepare("SELECT 1 FROM oauth_client WHERE client_id = ?")
				.bind(clientId)
				.first()) !== null;
		expect(await has("old-unused")).toBe(false);
		expect(await has("old-refreshing")).toBe(true);
		expect(await has("old-owned")).toBe(true);
		expect(await has(kept.clientId)).toBe(true);
		// Registered a moment ago and not yet allowed: the person may be on the consent page.
		expect(await has(waiting.clientId)).toBe(true);
	});
});
