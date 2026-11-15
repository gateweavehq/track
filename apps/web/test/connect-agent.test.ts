import { createHash, createHmac, hkdfSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuditPage } from "@gateweave/track-protocol";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RECEIVER_HOST, type ReceivedWebhook, startTrack } from "./track-worker";

// Connecting an agent in one step (TRK-138), through the built Worker: the page's server functions,
// the one-time code's exchange, and the undo, against real accounts, a real workspace object and
// real agent keys.

const origin = "https://track.test";
const asker = `https://${RECEIVER_HOST}`;
const webhookUrl = `${asker}/api/triggers/w1/t1`;
const returnUrl = `${asker}/api/track/connected`;
const PASSWORD = "a-long-test-password";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin, { vars: { CONNECT_ORIGINS: "https://known.test" } });
});

afterAll(async () => {
	await track?.dispose();
});

let calls = 0;
/** A client address of its own for each call, so no limit on one address gets in the way. */
const freshAddress = () => `198.51.100.${(++calls % 250) + 1}`;

async function authApi(path: string, cookie: string | null, body: object) {
	const response = await track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			"cf-connecting-ip": freshAddress(),
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response;
}

interface Person {
	id: string;
	name: string;
	email: string;
	cookie: string;
}

async function signUp(name: string): Promise<Person> {
	const email = `${name.toLowerCase().replace(/\W+/g, "-")}@connect.test`;
	const response = await authApi("/sign-up/email", null, { name, email, password: PASSWORD });
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, name, email, cookie };
}

async function workspaceOf(owner: Person, slug: string): Promise<string> {
	const response = await authApi("/organization/create", owner.cookie, { name: slug, slug });
	return ((await response.json()) as { id: string }).id;
}

function profile(person: Person, role: string) {
	return { id: person.id, name: person.name, email: person.email, image: null, role };
}

async function addMember(workspaceId: string, person: Person, role: string) {
	await track.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, person.id, role, Date.now())
		.run();
}

/** A workspace with an owner and a team, and the owner's address in the object. */
async function setUp(slug: string) {
	const owner = await signUp(`Owner of ${slug}`);
	const workspaceId = await workspaceOf(owner, slug);
	const team = await track.mutate(workspaceId, profile(owner, "owner"), {
		name: "team.create",
		args: { id: `team-${slug}`, key: "ENG", name: "Engineering" },
	});
	expect(team.ok).toBe(true);
	return { owner, workspaceId, slug, teamId: `team-${slug}` };
}

// Server functions, called as the browser does.

const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
function serverFnUrl(name: string) {
	const resolver = readdirSync(assets).find((file) =>
		/^__23tanstack-start-server-fn-resolver-.*\.js$/.test(file),
	);
	const source = resolver ? readFileSync(join(assets, resolver), "utf8") : "";
	const id = new RegExp(
		`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
	).exec(source)?.[1];
	if (!id) throw new Error(`No server function ${name} in the build`);
	return `${origin}/_serverFn/${id}`;
}

let nodes = 0;
/** A value as Seroval's JSON, for strings, null, booleans, numbers and plain objects. */
function encode(value: unknown): unknown {
	if (value === null) return { t: 2, s: 0 };
	if (typeof value === "string") return { t: 1, s: value };
	if (typeof value === "number") return { t: 0, s: value };
	if (typeof value === "boolean") return { t: 2, s: value ? 2 : 3 };
	const entries = Object.entries(value as object);
	return {
		t: 10,
		i: ++nodes,
		p: { k: entries.map(([key]) => key), v: entries.map(([, each]) => encode(each)) },
		o: 0,
	};
}

/** Reads the plain values of Seroval's JSON. */
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

async function serverFn<T>(
	name: string,
	method: "GET" | "POST",
	data: unknown,
	{ cookie, from = origin }: { cookie?: string; from?: string | null } = {},
): Promise<{ text: string; result: T; status: number }> {
	const body = JSON.stringify({ t: encode({ data }), f: 0, m: [] });
	const url =
		method === "GET"
			? `${serverFnUrl(name)}?payload=${encodeURIComponent(body)}`
			: serverFnUrl(name);
	const response = await track.fetch(url, {
		method,
		headers: {
			"x-tsr-serverFn": "true",
			accept: "application/json",
			"cf-connecting-ip": freshAddress(),
			...(from && { origin: from }),
			...(cookie && { cookie }),
			...(method === "POST" && { "content-type": "application/json" }),
		},
		...(method === "POST" && { body }),
	});
	const text = await response.text();
	const json = response.headers.get("content-type")?.includes("json");
	const { result } = (json ? decode(JSON.parse(text)) : { result: undefined }) as { result: T };
	return { text, result, status: response.status };
}

// What another server does.

const base64url = (bytes: Buffer) => bytes.toString("base64url");
const newVerifier = () => base64url(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
const challengeOf = (verifier: string) => base64url(createHash("sha256").update(verifier).digest());

function connectQuery(verifier: string, overrides: Record<string, string | undefined> = {}) {
	const params = new URLSearchParams({
		purpose: "work",
		name: "Coder",
		webhook: webhookUrl,
		events: "issue.created,comment.created",
		return: returnUrl,
		state: "state-123_abc",
		challenge: challengeOf(verifier),
	});
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) params.delete(key);
		else params.set(key, value);
	}
	return `?${params}`;
}

interface Approval {
	ok: boolean;
	redirect?: string;
	message?: string;
}

function approve(
	person: Person | null,
	query: string,
	choice: {
		workspace: string;
		teamId?: string | null;
		name?: string;
		decision?: "allow" | "cancel";
	},
	options: { from?: string | null } = {},
) {
	return serverFn<Approval>(
		"approveAgentConnection",
		"POST",
		{
			query,
			decision: choice.decision ?? "allow",
			workspace: choice.workspace,
			teamId: choice.teamId ?? null,
			name: choice.name ?? "Coder",
		},
		{ ...(person && { cookie: person.cookie }), ...options },
	);
}

/** Allows a connection and returns what the other server was sent: its code and state. */
async function allow(person: Person, workspace: string, verifier: string, teamId?: string | null) {
	const { result } = await approve(person, connectQuery(verifier), { workspace, teamId });
	expect(result.ok, result.message).toBe(true);
	const url = new URL(result.redirect ?? "");
	return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state"), url };
}

interface Exchanged {
	agentKey: string;
	webhookSecret: string;
	agent: { id: string; memberId: string; name: string };
	workspace: { id: string; slug: string; name: string };
	webhook: { id: string };
	undo: string;
}

function post(
	path: string,
	body: unknown,
	{ cookie, client }: { cookie?: string; client?: string } = {},
) {
	return track.fetch(`${origin}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-connecting-ip": client ?? freshAddress(),
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
}

const exchange = (code: string, verifier: string, options?: { cookie?: string; client?: string }) =>
	post("/api/connect/exchange", { code, verifier }, options);
const undo = (token: string, options?: { cookie?: string; client?: string }) =>
	post("/api/connect/undo", { undo: token }, options);

async function exchanged(code: string, verifier: string): Promise<Exchanged> {
	const response = await exchange(code, verifier);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as Exchanged;
}

// What is in Track.

async function agentCount(workspaceId: string) {
	const row = await track.db
		.prepare("SELECT count(*) AS n FROM member WHERE organization_id = ? AND role = 'agent'")
		.bind(workspaceId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function codeRows() {
	const { results } = await track.db
		.prepare(
			"SELECT identifier, value, expires_at FROM verification WHERE identifier LIKE 'track-connect:%'",
		)
		.all<{ identifier: string; value: string; expires_at: number }>();
	return results;
}

const webhooksOf = async (workspaceId: string, owner: Person) =>
	(
		await track.rpc<{ ok: true; value: { webhooks: { id: string; agentId: string | null }[] } }>(
			workspaceId,
			"webhooks",
			profile(owner, "owner"),
		)
	).value.webhooks;

async function auditOf(workspaceId: string, owner: Person) {
	const page = await track.rpc<{ ok: true; value: AuditPage }>(
		workspaceId,
		"auditLog",
		profile(owner, "owner"),
		{},
	);
	return page.value.events;
}

/** Checks a Standard Webhooks signature, as a receiver would. */
function verified(request: ReceivedWebhook, secret: string): unknown {
	const id = request.headers["webhook-id"];
	const timestamp = request.headers["webhook-timestamp"];
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${request.body}`);
	expect(request.headers["webhook-signature"]).toBe(`v1,${expected.digest("base64")}`);
	return JSON.parse(request.body);
}

async function mcpAs(key: string) {
	const client = new Client({ name: "coder", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
			fetch: track.fetch,
			requestInit: { headers: { authorization: `Bearer ${key}` } },
		}),
	);
	return client;
}

const NO_CODE = { error: "invalid_code" };

describe("connecting an agent", () => {
	it("makes an agent and a webhook for an admin, and hands their secrets to the asking server once", async () => {
		const { owner, workspaceId, slug, teamId } = await setUp("hq");
		const verifier = newVerifier();

		// What the page shows an admin.
		const offer = await serverFn<{
			ok: boolean;
			asker: string;
			known: boolean;
			suggestedName: string;
			events: string[];
			workspaces: { slug: string; name: string }[];
		}>("getConnectOffer", "GET", connectQuery(verifier), { cookie: owner.cookie });
		expect(offer.result).toMatchObject({
			ok: true,
			asker,
			known: false,
			suggestedName: "Coder",
			events: ["issue.created", "comment.created"],
			workspaces: [{ slug, name: slug }],
		});
		const teams = await serverFn<unknown>("getConnectTeams", "GET", slug, { cookie: owner.cookie });
		// Only what the choice needs: a team also holds the secret parts of its intake links.
		expect(teams.result).toEqual([{ id: teamId, key: "ENG", name: "Engineering" }]);

		const { code, state, url } = await allow(owner, slug, verifier, teamId);
		expect(state).toBe("state-123_abc");
		expect(url.origin + url.pathname).toBe(returnUrl);
		expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

		// Nothing secret is kept in the clear, and the code itself is not kept at all.
		const [row] = await codeRows();
		expect(await codeRows()).toHaveLength(1);
		expect(row?.identifier).not.toContain(code);
		// The code is good for a minute. The row itself is kept for days, so that it is still there
		// to take back what it was made for if nobody trades the code.
		const { goodUntil, sweepAt } = JSON.parse(row?.value ?? "{}") as Record<string, number>;
		expect(goodUntil).toBeGreaterThan(Date.now());
		expect(goodUntil).toBeLessThanOrEqual(Date.now() + 61_000);
		expect(sweepAt).toBe(goodUntil);
		expect(row?.expires_at).toBeGreaterThan(Date.now() + 2 * 24 * 60 * 60 * 1000);

		const response = await exchange(code, verifier);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toBeNull();
		const secrets = (await response.json()) as Exchanged;
		expect(secrets).toMatchObject({
			agent: { name: "Coder" },
			workspace: { id: workspaceId, slug, name: slug },
		});
		expect(secrets.agent.id).toMatch(/\S/);
		expect(secrets.agent.memberId).toMatch(/\S/);
		expect(secrets.agentKey).toMatch(/^gwt_[A-Za-z0-9_-]{43}$/);
		expect(secrets.webhookSecret).toMatch(/^whsec_/);
		expect(secrets.undo).toMatch(/\S/);
		expect(await codeRows()).toHaveLength(0);

		// The key works against /mcp as that agent member.
		const mcp = await mcpAs(secrets.agentKey);
		const workspaces = await mcp.callTool({ name: "list_workspaces", arguments: {} });
		await mcp.close();
		expect(workspaces.structuredContent).toEqual({
			workspaces: [{ slug, name: slug, role: "agent" }],
		});

		// The webhook is for that agent and that team, and its secret signs what it delivers.
		const [webhook] = await webhooksOf(workspaceId, owner);
		expect(webhook).toMatchObject({ id: secrets.webhook.id, agentId: secrets.agent.id });
		const made = await track.mutate(workspaceId, profile(owner, "owner"), {
			name: "issue.create",
			args: { id: "issue-1", teamId, title: "First", sortOrder: "a0" },
		});
		expect(made.ok).toBe(true);
		await vi.waitFor(() => expect(track.received).toHaveLength(1), { timeout: 5000 });
		const delivery = track.received[0] as ReceivedWebhook;
		expect(delivery.url).toBe(webhookUrl);
		expect(verified(delivery, secrets.webhookSecret)).toMatchObject({ type: "issue.created" });

		// The log says who connected what, and holds none of the secrets.
		const events = await auditOf(workspaceId, owner);
		expect(events.map((each) => each.action)).toEqual(
			expect.arrayContaining(["agent.created", "webhook.created", "agent.connected"]),
		);
		expect(events.find((each) => each.action === "agent.connected")).toMatchObject({
			actorId: owner.id,
			target: { type: "agent", id: secrets.agent.id, label: "Coder" },
			detail: { origin: asker, webhook: secrets.webhook.id },
		});
		const logged = JSON.stringify(events);
		for (const secret of [secrets.agentKey, secrets.webhookSecret, code, verifier, secrets.undo]) {
			expect(logged).not.toContain(secret);
		}
		// Nor does the page's data or the approval's answer: a key never goes to the browser.
		expect(offer.text).not.toContain(secrets.agentKey);
	});

	it("refuses an approval that is not an admin's, and one for another workspace's", async () => {
		const mine = await setUp("mine");
		const theirs = await setUp("theirs");
		const member = await signUp("Plain Member");
		await addMember(mine.workspaceId, member, "member");
		const verifier = newVerifier();
		const query = connectQuery(verifier);

		// A member of one workspace and no admin: nothing to choose, and no way to approve.
		const offer = await serverFn<{ ok: boolean; problem?: string }>(
			"getConnectOffer",
			"GET",
			query,
			{
				cookie: member.cookie,
			},
		);
		expect(offer.result.ok).toBe(false);
		expect(offer.result.problem).toMatch(/owner or admin/);
		const refused = await approve(member, query, { workspace: mine.slug });
		expect(refused.result).toMatchObject({ ok: false });
		expect(refused.result.redirect).toBeUndefined();
		const teams = await serverFn<unknown>("getConnectTeams", "GET", mine.slug, {
			cookie: member.cookie,
		});
		expect(teams.result).toBeNull();

		// Another workspace's admin cannot make anything in this one, which they are not in.
		const other = await approve(theirs.owner, query, { workspace: mine.slug });
		expect(other.result).toMatchObject({ ok: false });
		expect(other.result.message).toBe(refused.result.message);
		expect(
			(
				await serverFn<unknown>("getConnectTeams", "GET", mine.slug, {
					cookie: theirs.owner.cookie,
				})
			).result,
		).toBeNull();

		// A workspace that is not there answers the same, and nobody signed in is refused.
		expect((await approve(member, query, { workspace: "no-such" })).result.message).toBe(
			refused.result.message,
		);
		expect((await approve(null, query, { workspace: mine.slug })).result.ok).toBe(false);
		expect((await serverFn<{ ok: boolean }>("getConnectOffer", "GET", query)).result.ok).toBe(
			false,
		);

		expect(await agentCount(mine.workspaceId)).toBe(0);
		expect(await webhooksOf(mine.workspaceId, mine.owner)).toEqual([]);
		expect(await codeRows()).toEqual([]);
	});

	it("lists only the workspaces a person is an admin of", async () => {
		const first = await setUp("listed-a");
		const second = await setUp("listed-b");
		await addMember(second.workspaceId, first.owner, "member");
		const offer = await serverFn<{ ok: boolean; workspaces: { slug: string }[] }>(
			"getConnectOffer",
			"GET",
			connectQuery(newVerifier()),
			{ cookie: first.owner.cookie },
		);
		expect(offer.result.workspaces.map((each) => each.slug)).toEqual(["listed-a"]);
		// As a member of the second, they cannot add an agent to it either.
		const answer = await approve(first.owner, connectQuery(newVerifier()), {
			workspace: "listed-b",
		});
		expect(answer.result.ok).toBe(false);
		expect(await agentCount(second.workspaceId)).toBe(0);
	});

	it("shows an origin listed in CONNECT_ORIGINS as known", async () => {
		const { owner } = await setUp("known");
		const query = connectQuery(newVerifier(), {
			webhook: "https://known.test/hook",
			return: "https://known.test/back",
		});
		const offer = await serverFn<{ ok: boolean; known: boolean; asker: string }>(
			"getConnectOffer",
			"GET",
			query,
			{ cookie: owner.cookie },
		);
		expect(offer.result).toMatchObject({ ok: true, known: true, asker: "https://known.test" });
	});

	it("refuses every malformed or mismatched request, with no address to go to", async () => {
		const { owner, workspaceId, slug } = await setUp("strict");
		const verifier = newVerifier();
		const bad: Record<string, string | undefined>[] = [
			{ webhook: "http://hooks.test/hook", return: "http://hooks.test/back" },
			{ return: "https://other.test/back" },
			{ webhook: "https://user:pw@hooks.test/hook" },
			{ return: "https://user@hooks.test/back" },
			{ events: "issue.created,issue.exploded" },
			{ webhook: "https://track.test/hook", return: "https://track.test/back" },
			{ purpose: "rule" },
			{ state: "not url safe" },
			{ challenge: "short" },
			{ name: "n".repeat(81) },
		];
		for (const overrides of bad) {
			const query = connectQuery(verifier, overrides);
			const offer = await serverFn<{ ok: boolean }>("getConnectOffer", "GET", query, {
				cookie: owner.cookie,
			});
			expect(offer.result.ok, query).toBe(false);
			const answer = await approve(owner, query, { workspace: slug });
			expect(answer.result.ok, query).toBe(false);
			expect(answer.result.redirect, query).toBeUndefined();
			const denied = await approve(owner, query, { workspace: slug, decision: "cancel" });
			expect(denied.result.redirect, query).toBeUndefined();
		}
		// What the page sends back for the name is checked too.
		const named = await approve(owner, connectQuery(verifier), { workspace: slug, name: "   " });
		expect(named.result.ok).toBe(false);
		const long = await approve(owner, connectQuery(verifier), {
			workspace: slug,
			name: "x".repeat(81),
		});
		expect(long.result.ok).toBe(false);
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
	});

	it("makes nothing on Cancel, and goes back with the denial", async () => {
		const { owner, workspaceId, slug } = await setUp("cancel");
		const query = connectQuery(newVerifier(), { return: `${returnUrl}?keep=1` });
		const { result } = await approve(owner, query, { workspace: slug, decision: "cancel" });
		expect(result.ok).toBe(true);
		const url = new URL(result.redirect ?? "");
		expect(url.origin + url.pathname).toBe(returnUrl);
		expect([...url.searchParams]).toEqual([
			["keep", "1"],
			["error", "denied"],
			["state", "state-123_abc"],
		]);
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
		expect(await codeRows()).toEqual([]);
	});

	it("refuses an approval that does not come from Track's own page", async () => {
		const { owner, workspaceId, slug } = await setUp("sameorigin");
		const query = connectQuery(newVerifier());
		for (const from of ["https://evil.test", null, "https://track.test.evil.test"]) {
			const { result, status } = await approve(owner, query, { workspace: slug }, { from });
			// Start's own CSRF check turns these away before the function runs; the function checks again.
			expect(status === 403 || result?.ok === false, String(from)).toBe(true);
		}
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
	});

	it("takes a code once, in a minute, with its verifier, and says the same whatever is wrong", async () => {
		const { owner, slug } = await setUp("codes");

		// Once.
		const v1 = newVerifier();
		const first = await allow(owner, slug, v1);
		await exchanged(first.code, v1);
		const again = await exchange(first.code, v1);
		expect(again.status).toBe(400);
		const used = await again.text();
		expect(JSON.parse(used)).toEqual(NO_CODE);

		// A wrong verifier, which spends the code all the same.
		const v2 = newVerifier();
		const second = await allow(owner, slug, v2);
		const wrong = await exchange(second.code, newVerifier());
		expect(wrong.status).toBe(400);
		expect(await wrong.text()).toBe(used);
		expect((await exchange(second.code, v2)).status).toBe(400);

		// Late: the minute is past.
		const v3 = newVerifier();
		const third = await allow(owner, slug, v3);
		await track.db
			.prepare(
				"UPDATE verification SET value = json_set(value, '$.goodUntil', ?1, '$.sweepAt', ?1) WHERE identifier LIKE 'track-connect:%'",
			)
			.bind(Date.now() - 1000)
			.run();
		const late = await exchange(third.code, v3);
		expect(late.status).toBe(400);
		expect(await late.text()).toBe(used);
		expect(await codeRows()).toEqual([]);

		// A code nobody made, and answers that are not even shaped like one.
		const unknown = await exchange(base64url(Buffer.alloc(32, 7)), v1);
		expect(unknown.status).toBe(400);
		expect(await unknown.text()).toBe(used);
		for (const body of [{}, { code: 1 }, { code: first.code }, "nope"]) {
			const odd = await post("/api/connect/exchange", body);
			expect(odd.status).toBe(400);
			expect(await odd.text()).toBe(used);
		}
		// With the wrong method it is not an exchange at all.
		expect((await track.fetch(`${origin}/api/connect/exchange`)).status).toBe(405);
	});

	it("lets exactly one of two simultaneous exchanges win", async () => {
		const { owner, slug } = await setUp("race");
		for (let round = 0; round < 3; round++) {
			const verifier = newVerifier();
			const { code } = await allow(owner, slug, verifier);
			const answers = await Promise.all(Array.from({ length: 4 }, () => exchange(code, verifier)));
			expect(answers.map((each) => each.status).sort()).toEqual([200, 400, 400, 400]);
		}
	});

	it("leaves no agent behind when the webhook cannot be made", async () => {
		const { owner, workspaceId, slug } = await setUp("full");
		const admin = profile(owner, "owner");
		const link = { id: workspaceId, slug, origin };
		for (let i = 0; i < 10; i++) {
			const made = await track.rpc<{ ok: boolean }>(workspaceId, "createWebhook", admin, link, {
				url: `https://${RECEIVER_HOST}/filler/${i}`,
				events: ["issue.created"],
				teamId: null,
				agentId: null,
			});
			expect(made.ok).toBe(true);
		}
		const { result } = await approve(owner, connectQuery(newVerifier()), { workspace: slug });
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/at most 10 webhooks/);
		expect(result.message).toMatch(/Nothing was made/);
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toHaveLength(10);
		expect(await codeRows()).toEqual([]);
		// The agent's account is gone from the workspace's object too.
		const members = await track.directory(workspaceId);
		expect(
			(members.members as { role: string; removedAt?: number }[]).filter(
				(each) => each.role === "agent" && !each.removedAt,
			),
		).toEqual([]);
	});
});

describe("undoing a connection", () => {
	/** Re-signs a token's parts, as Track does, to make ones it never gave out. */
	function signedUndo(parts: string[], expires: number) {
		const key = hkdfSync(
			"sha256",
			Buffer.from(track.authSecret),
			Buffer.alloc(0),
			"track-connect-undo-v1",
			64,
		);
		const mac = createHmac("sha256", Buffer.from(key))
			.update(`track-connect-undo-v1:${parts.join(":")}:${expires}`)
			.digest();
		return [...parts, expires, base64url(mac)].join(".");
	}

	it("removes exactly the agent and the webhook, as often as asked", async () => {
		const { owner, workspaceId, slug } = await setUp("undone");
		// Another agent and webhook of the workspace, which must stay.
		const bystander = await (
			await authApi("/agents/create", owner.cookie, {
				organizationId: workspaceId,
				name: "Bystander",
			})
		).json();
		const bystanderId = (bystander as { agent: { id: string } }).agent.id;
		const kept = await track.rpc<{ ok: boolean; value: { webhook: { id: string } } }>(
			workspaceId,
			"createWebhook",
			profile(owner, "owner"),
			{ id: workspaceId, slug, origin },
			{
				url: `https://${RECEIVER_HOST}/kept`,
				events: ["issue.created"],
				teamId: null,
				agentId: bystanderId,
			},
		);
		expect(kept.ok).toBe(true);

		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		const secrets = await exchanged(code, verifier);
		expect(await agentCount(workspaceId)).toBe(2);

		// A token for something else, or altered, or without its signature, does nothing.
		const [ws = "", agent = "", webhook = "", expires = "", signature = ""] =
			secrets.undo.split(".");
		for (const token of [
			`${ws}.${agent}.${kept.value.webhook.id}.${expires}.${signature}`,
			`${ws}.${bystanderId}.${webhook}.${expires}.${signature}`,
			`${ws}.${agent}.${webhook}.${Number(expires) + 600}.${signature}`,
			`${ws}.${agent}.${webhook}.${expires}.${"A".repeat(43)}`,
			`${ws}.${agent}.${webhook}.${expires}`,
			"garbage",
			"",
		]) {
			const refused = await undo(token);
			expect(refused.status, token).toBe(400);
			expect(await refused.json()).toEqual({ error: "invalid_undo" });
		}
		// Signed rightly but late.
		const late = await undo(signedUndo([ws, agent, webhook], Math.floor(Date.now() / 1000) - 1));
		expect(late.status).toBe(400);
		expect(await agentCount(workspaceId)).toBe(2);
		expect(await webhooksOf(workspaceId, owner)).toHaveLength(2);

		const done = await undo(secrets.undo);
		expect(done.status).toBe(200);
		expect(done.headers.get("cache-control")).toBe("no-store");
		expect(await done.json()).toEqual({ ok: true });
		expect(await agentCount(workspaceId)).toBe(1);
		expect(await webhooksOf(workspaceId, owner)).toEqual([
			expect.objectContaining({ id: kept.value.webhook.id, agentId: bystanderId }),
		]);
		// The key is dead, and the answer is the same the second time.
		const key = await track.fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${secrets.agentKey}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: "{}",
		});
		expect(key.status).toBe(401);
		const twice = await undo(secrets.undo);
		expect(twice.status).toBe(200);
		expect(await twice.json()).toEqual({ ok: true });
		expect(await agentCount(workspaceId)).toBe(1);
		// The log has the removals, by Track itself.
		const actions = (await auditOf(workspaceId, owner)).filter((each) => each.actorId === null);
		expect(actions.map((each) => each.action).sort()).toEqual(["agent.deleted", "webhook.deleted"]);
	});

	it("does not remove a webhook that belongs to another agent than the token names", async () => {
		const { owner, workspaceId, slug } = await setUp("regiven");
		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		const secrets = await exchanged(code, verifier);
		const [ws = "", , webhook = ""] = secrets.undo.split(".");
		// A token signed for this webhook but another agent's id removes neither.
		const stranger = await (
			await authApi("/agents/create", owner.cookie, {
				organizationId: workspaceId,
				name: "Stranger",
			})
		).json();
		const strangerId = (stranger as { agent: { id: string } }).agent.id;
		const token = signedUndo([ws, strangerId, webhook], Math.floor(Date.now() / 1000) + 300);
		expect((await undo(token)).status).toBe(200);
		expect(await webhooksOf(workspaceId, owner)).toHaveLength(1);
	});
});

/** A token Track never gave out but that its key signs, as a test-only way to make odd ones. */
function signToken(parts: string[], expires: number) {
	const key = hkdfSync(
		"sha256",
		Buffer.from(track.authSecret),
		Buffer.alloc(0),
		"track-connect-undo-v1",
		64,
	);
	const mac = createHmac("sha256", Buffer.from(key))
		.update(`track-connect-undo-v1:${parts.join(":")}:${expires}`)
		.digest();
	return [...parts, expires, base64url(mac)].join(".");
}

/** Makes D1 refuse what the trigger names, for as long as `during` runs. */
async function breaking<T>(table: string, when: string, during: () => Promise<T>): Promise<T> {
	await track.db
		.prepare(
			`CREATE TRIGGER test_break BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'broken for a test'); END`,
		)
		.run();
	try {
		return await during();
	} finally {
		await track.db.prepare("DROP TRIGGER test_break").run();
	}
}

async function directoryAgent(workspaceId: string, agentId: string) {
	const { members } = await track.directory(workspaceId);
	return (members as { id: string; removedAt?: number }[]).find((each) => each.id === agentId);
}

describe("hardening", () => {
	it("undoes again after a first undo deleted the rows but could not tell the object", async () => {
		const { owner, workspaceId, slug } = await setUp("ghost");
		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		const secrets = await exchanged(code, verifier);
		expect((await directoryAgent(workspaceId, secrets.agent.id))?.removedAt ?? null).toBeNull();

		// What a first undo leaves when its sync fails: the rows are gone, the object still has the
		// member. The sync cannot be made to fail from here, so its aftermath is made directly.
		for (const sql of [
			"DELETE FROM agent_key WHERE user_id = ?",
			"DELETE FROM member WHERE user_id = ?",
			"DELETE FROM user WHERE id = ?",
		]) {
			await track.db.prepare(sql).bind(secrets.agent.id).run();
		}
		expect((await directoryAgent(workspaceId, secrets.agent.id))?.removedAt ?? null).toBeNull();

		expect((await undo(secrets.undo)).status).toBe(200);
		expect((await directoryAgent(workspaceId, secrets.agent.id))?.removedAt).toBeGreaterThan(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
	});

	it("takes only a verifier shaped like PKCE's, and does not spend the code on any other", async () => {
		const { owner, slug } = await setUp("shapes");
		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		for (const odd of [
			"short",
			"a".repeat(42),
			"a".repeat(129),
			`${"a".repeat(42)}!`,
			`${verifier} `,
		]) {
			const answer = await exchange(code, odd);
			expect(answer.status, odd).toBe(400);
			expect(await answer.json()).toEqual(NO_CODE);
		}
		// Still there for the right one. A well-formed wrong verifier spends it.
		expect(await codeRows()).toHaveLength(1);
		expect((await exchange(code, newVerifier())).status).toBe(400);
		expect(await codeRows()).toHaveLength(0);
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	it("does not open a row whose challenge was changed", async () => {
		const { owner, slug } = await setUp("swapped");
		const verifier = newVerifier();
		const attacker = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		const [row] = await codeRows();
		const value = JSON.parse(row?.value ?? "{}") as { challenge: string };
		value.challenge = challengeOf(attacker);
		await track.db
			.prepare("UPDATE verification SET value = ? WHERE identifier = ?")
			.bind(JSON.stringify(value), row?.identifier)
			.run();
		const answer = await exchange(code, attacker);
		expect(answer.status).toBe(400);
		expect(await answer.json()).toEqual(NO_CODE);
	});

	it("keeps the app's referrer policy, and forbids framing the page", async () => {
		const { owner } = await setUp("framing");
		const page = await track.fetch(`${origin}/connect/agent${connectQuery(newVerifier())}`, {
			headers: { cookie: owner.cookie, "cf-connecting-ip": freshAddress() },
		});
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		// The app's own policy for every response; it sends only the origin across sites.
		expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
		const answer = await exchange("x", "y");
		expect(answer.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
	});

	it("refuses an approval from an opaque origin", async () => {
		const { owner, workspaceId, slug } = await setUp("opaque");
		const { result, status } = await approve(
			owner,
			connectQuery(newVerifier()),
			{ workspace: slug },
			{ from: "null" },
		);
		expect(status === 403 || result?.ok === false).toBe(true);
		expect(await agentCount(workspaceId)).toBe(0);
	});

	it("leaves neither the agent nor the webhook when the code cannot be kept", async () => {
		const { owner, workspaceId, slug } = await setUp("unkept");
		const { result } = await breaking("verification", "NEW.identifier LIKE 'track-connect:%'", () =>
			approve(owner, connectQuery(newVerifier()), { workspace: slug }),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/Nothing was made/);
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
		expect(await codeRows()).toEqual([]);
	});

	it("has the agents plugin remove exactly the rows of an agent whose creation fails, whatever else is made at once", async () => {
		const { owner, workspaceId, slug } = await setUp("keyless");
		const named = (name: string) =>
			track.db
				.prepare(
					"SELECT (SELECT count(*) FROM user WHERE name = ?1 AND email LIKE '%@agents.invalid') AS users, (SELECT count(*) FROM member m JOIN user u ON u.id = m.user_id WHERE u.name = ?1 AND m.organization_id = ?2) AS members, (SELECT count(*) FROM agent_key k JOIN user u ON u.id = k.user_id WHERE u.name = ?1) AS keys",
				)
				.bind(name, workspaceId)
				.first<{ users: number; members: number; keys: number }>();
		// The key is inserted after the member, so refusing the key of "Doomed" fails its creation
		// halfway, while the creation of "Survivor" at the same moment is not touched.
		const [doomed, survivor] = await breaking(
			"agent_key",
			"(SELECT name FROM user WHERE id = NEW.user_id) = 'Doomed'",
			() =>
				Promise.all([
					approve(owner, connectQuery(newVerifier()), { workspace: slug, name: "Doomed" }),
					authApi("/agents/create", owner.cookie, {
						organizationId: workspaceId,
						name: "Survivor",
					}),
				]),
		);
		expect(doomed.result.ok).toBe(false);
		expect(survivor.ok).toBe(true);
		expect(await named("Doomed")).toEqual({ users: 0, members: 0, keys: 0 });
		expect(await named("Survivor")).toEqual({ users: 1, members: 1, keys: 1 });
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);

		// The same through Settings, which uses the same plugin: an error, and nothing left over.
		const settings = await breaking(
			"agent_key",
			"(SELECT name FROM user WHERE id = NEW.user_id) = 'Doomed'",
			() =>
				track.fetch(`${origin}/api/auth/agents/create`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin,
						"cf-connecting-ip": freshAddress(),
						cookie: owner.cookie,
					},
					body: JSON.stringify({ organizationId: workspaceId, name: "Doomed" }),
				}),
		);
		expect(settings.ok).toBe(false);
		expect(await named("Doomed")).toEqual({ users: 0, members: 0, keys: 0 });
	});

	it("clears a webhook of the agent that its token does not know of", async () => {
		const { owner, workspaceId, slug } = await setUp("unknownhook");
		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		const secrets = await exchanged(code, verifier);
		// As when the answer about the webhook was lost: another one naming this agent.
		const extra = await track.rpc<{ ok: boolean }>(
			workspaceId,
			"createWebhook",
			profile(owner, "owner"),
			{ id: workspaceId, slug, origin },
			{
				url: `https://${RECEIVER_HOST}/extra`,
				events: ["issue.created"],
				teamId: null,
				agentId: secrets.agent.id,
			},
		);
		expect(extra.ok).toBe(true);
		expect(await webhooksOf(workspaceId, owner)).toHaveLength(2);
		expect((await undo(secrets.undo)).status).toBe(200);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
		expect(await agentCount(workspaceId)).toBe(0);
	});

	it("answers a token that verifies but names something malformed with the usual 400", async () => {
		const { workspaceId } = await setUp("malformed");
		const soon = Math.floor(Date.now() / 1000) + 300;
		for (const parts of [
			[workspaceId, "a".repeat(65), "w"],
			[workspaceId, "agent", "w".repeat(65)],
			[workspaceId, "agént", "w"],
			["", "agent", "w"],
		]) {
			const answer = await undo(signToken(parts, soon));
			expect(answer.status, parts.join("/")).toBe(400);
			expect(await answer.json()).toEqual({ error: "invalid_undo" });
		}
	});
});

describe("the endpoints for servers", () => {
	it("ignore cookies, and count their callers", async () => {
		const { owner } = await setUp("cookies");
		// A signed-in admin's cookie opens nothing here.
		const code = base64url(Buffer.alloc(32, 9));
		const withCookie = await exchange(code, newVerifier(), { cookie: owner.cookie });
		expect(withCookie.status).toBe(400);
		expect(await withCookie.json()).toEqual(NO_CODE);
		expect((await undo("garbage", { cookie: owner.cookie })).status).toBe(400);
		expect(withCookie.headers.get("set-cookie")).toBeNull();

		// Past the limit, one address is turned away; another is not, and undo shares the count.
		const client = "203.0.113.250";
		const statuses: number[] = [];
		for (let i = 0; i < 24; i++)
			statuses.push((await exchange(code, newVerifier(), { client })).status);
		expect(statuses.slice(0, 20)).toEqual(Array(20).fill(400));
		expect(statuses.slice(20)).toEqual([429, 429, 429, 429]);
		const limited = await exchange(code, newVerifier(), { client });
		expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
		expect(limited.headers.get("cache-control")).toBe("no-store");
		expect((await undo("garbage", { client })).status).toBe(429);
		expect((await exchange(code, newVerifier(), { client: "203.0.113.251" })).status).toBe(400);
	});

	it("count a Worker by its zone, as other Workers' requests share one address", async () => {
		const workersAddress = "2a06:98c0:3600::103";
		const call = (zone: string) =>
			track.fetch(`${origin}/api/connect/exchange`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": workersAddress,
					"cf-worker": zone,
				},
				body: JSON.stringify({ code: base64url(Buffer.alloc(32, 3)), verifier: "v" }),
			});
		for (let i = 0; i < 21; i++) await call("busy.example.com");
		expect((await call("busy.example.com")).status).toBe(429);
		expect((await call("quiet.example.com")).status).toBe(400);
	});
});

describe("taking back a connection whose code is not used", () => {
	/** Makes every code past its minute. The rows stay, as they do for days. */
	const expireCodes = () =>
		track.db
			.prepare(
				"UPDATE verification SET value = json_set(value, '$.goodUntil', ?1, '$.sweepAt', ?1) WHERE identifier LIKE 'track-connect:%'",
			)
			.bind(Date.now() - 1000)
			.run();
	/** Makes every code row past its `expires_at`, which is all a row from Track 0.39.0 has. */
	const expireRows = () =>
		track.db
			.prepare("UPDATE verification SET expires_at = ? WHERE identifier LIKE 'track-connect:%'")
			.bind(Date.now() - 1000)
			.run();

	async function takenBackBy(workspaceId: string, owner: Person) {
		return (await auditOf(workspaceId, owner)).filter(
			(each) => each.action === "agent.deleted" && each.actorId === null,
		);
	}

	it("takes back the agent and the webhook when a code is refused, and answers as ever", async () => {
		const { owner, workspaceId, slug } = await setUp("refused");

		// A wrong verifier.
		const v1 = newVerifier();
		const first = await allow(owner, slug, v1);
		expect(await agentCount(workspaceId)).toBe(1);
		const wrong = await exchange(first.code, newVerifier());
		expect(wrong.status).toBe(400);
		const answer = await wrong.text();
		expect(JSON.parse(answer)).toEqual(NO_CODE);
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
		expect(await codeRows()).toEqual([]);

		// A seal that does not open.
		const v2 = newVerifier();
		const second = await allow(owner, slug, v2);
		const [row] = await codeRows();
		const value = JSON.parse(row?.value ?? "{}") as { ct: string };
		// A change whatever it ended with.
		value.ct = `${value.ct.slice(0, -2)}${value.ct.endsWith("AA") ? "BB" : "AA"}`;
		await track.db
			.prepare("UPDATE verification SET value = ? WHERE identifier = ?")
			.bind(JSON.stringify(value), row?.identifier)
			.run();
		const broken = await exchange(second.code, v2);
		expect(broken.status).toBe(400);
		expect(await broken.text()).toBe(answer);
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);

		// Late.
		const v3 = newVerifier();
		const third = await allow(owner, slug, v3);
		await expireCodes();
		const late = await exchange(third.code, v3);
		expect(late.status).toBe(400);
		expect(await late.text()).toBe(answer);
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);

		// Each is in the log, by Track itself, with who asked and no secret.
		const events = await takenBackBy(workspaceId, owner);
		expect(events).toHaveLength(3);
		for (const event of events) expect(event.detail).toMatchObject({ origin: asker });
		expect(JSON.stringify(events)).not.toContain(first.code);
	});

	it("takes back only what the refused code made", async () => {
		const { owner, workspaceId, slug } = await setUp("only-its-own");
		const refusedOne = await allow(owner, slug, newVerifier());
		const verifier = newVerifier();
		const made = await allow(owner, slug, verifier);
		const keptSecrets = await exchanged(made.code, verifier);
		expect(await agentCount(workspaceId)).toBe(2);
		expect((await exchange(refusedOne.code, newVerifier())).status).toBe(400);
		expect(await agentCount(workspaceId)).toBe(1);
		const [webhook] = await webhooksOf(workspaceId, owner);
		expect(webhook).toMatchObject({ id: keptSecrets.webhook.id, agentId: keptSecrets.agent.id });
	});

	it("sweeps a code nobody traded when the next connection is approved", async () => {
		const { owner, workspaceId, slug } = await setUp("swept-by-allow");
		await allow(owner, slug, newVerifier());
		expect(await agentCount(workspaceId)).toBe(1);
		await expireCodes();

		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		// Only the new one is left, and it still works.
		expect(await agentCount(workspaceId)).toBe(1);
		expect(await webhooksOf(workspaceId, owner)).toHaveLength(1);
		expect(await codeRows()).toHaveLength(1);
		const secrets = await exchanged(code, verifier);
		expect((await webhooksOf(workspaceId, owner))[0]).toMatchObject({ agentId: secrets.agent.id });
		expect(await takenBackBy(workspaceId, owner)).toHaveLength(1);
	});

	it("sweeps a handful at a time on Allow, and the rest on the daily run", async () => {
		const { owner, workspaceId, slug } = await setUp("swept-in-bounds");
		for (let i = 0; i < 8; i++) await allow(owner, slug, newVerifier());
		expect(await agentCount(workspaceId)).toBe(8);
		await expireCodes();
		await allow(owner, slug, newVerifier());
		const left = await agentCount(workspaceId);
		expect(left).toBeGreaterThan(1);
		expect(left).toBeLessThan(9);
		await track.runScheduled();
		expect(await agentCount(workspaceId)).toBe(1);
		expect(await codeRows()).toHaveLength(1);
	});

	it("sweeps a code nobody traded on the daily run", async () => {
		const { owner, workspaceId, slug } = await setUp("swept-by-cron");
		await allow(owner, slug, newVerifier());
		expect(await agentCount(workspaceId)).toBe(1);
		await expireCodes();
		await track.runScheduled();
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
		expect(await codeRows()).toEqual([]);
		const [event] = await takenBackBy(workspaceId, owner);
		expect(event?.detail).toMatchObject({ origin: asker });
	});

	it("still takes back after a sign-in elsewhere cleared the table of what had run out", async () => {
		const { owner, workspaceId, slug } = await setUp("kept-past-cleanup");
		await allow(owner, slug, newVerifier());
		await expireCodes();
		// What Better Auth runs whenever it looks a verification up, a sign-in for one: every row
		// past its `expires_at` goes. Here as it would two minutes on, when the code's minute is
		// over; a code's row is not past its `expires_at` for days.
		await track.db
			.prepare("DELETE FROM verification WHERE expires_at < ?")
			.bind(Date.now() + 2 * 60_000)
			.run();
		expect(await codeRows()).toHaveLength(1);
		await track.runScheduled();
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await webhooksOf(workspaceId, owner)).toEqual([]);
		expect(await codeRows()).toEqual([]);
	});

	it("tries again later when taking back failed, and the code opens nothing meanwhile", async () => {
		const { owner, workspaceId, slug } = await setUp("taken-back-later");
		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		await expireCodes();

		// The agent's rows cannot be deleted for now, so taking it back fails part of the way.
		await track.db
			.prepare(
				"CREATE TRIGGER test_keep_member BEFORE DELETE ON member BEGIN SELECT RAISE(ABORT, 'broken for a test'); END",
			)
			.run();
		try {
			await track.runScheduled();
		} finally {
			await track.db.prepare("DROP TRIGGER test_keep_member").run();
		}
		expect(await agentCount(workspaceId)).toBe(1);

		// The row is back, for later: nothing of the seal in it, and no code opens it.
		const [kept] = await codeRows();
		const value = JSON.parse(kept?.value ?? "{}") as Record<string, unknown>;
		expect(value).toMatchObject({ workspaceId, tries: 1, goodUntil: 0 });
		expect(value.sweepAt).toBeGreaterThan(Date.now() + 30 * 60_000);
		expect(Object.keys(value)).not.toContain("ct");
		// Under a name no code hashes to: an exchange with the code finds nothing, so an asking
		// server that tries again cannot use the tries up in seconds.
		expect(kept?.identifier).toMatch(/^track-connect:retry\./);
		expect((await exchange(code, verifier)).status).toBe(400);
		expect(await codeRows()).toHaveLength(1);
		expect(JSON.parse((await codeRows())[0]?.value ?? "{}")).toMatchObject({ tries: 1 });
		// Not due yet, so a run now leaves it.
		await track.runScheduled();
		expect(await agentCount(workspaceId)).toBe(1);

		// When it is due, the agent goes.
		await expireCodes();
		await track.runScheduled();
		expect(await agentCount(workspaceId)).toBe(0);
		expect(await codeRows()).toEqual([]);
		expect((await exchange(code, verifier)).status).toBe(400);
	});

	it("sweeps beside rows of Better Auth's whose values are not JSON, and matches its own prefix exactly", async () => {
		const { owner, workspaceId, slug } = await setUp("beside-others");
		await allow(owner, slug, newVerifier());
		await expireCodes();
		// What Better Auth keeps for a password reset: a bare id. And a row named like ours but for
		// the case, which is not ours.
		const insert =
			"INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)";
		const later = Date.now() + 60 * 60_000;
		await track.db
			.prepare(insert)
			.bind("test-plain", "reset-password:abc", "not json at all", later, Date.now(), Date.now())
			.run();
		await track.db
			.prepare(insert)
			.bind("test-case", "TRACK-CONNECT:abc", "also not json", later, Date.now(), Date.now())
			.run();
		try {
			await track.runScheduled();
			expect(await agentCount(workspaceId)).toBe(0);
			// Ours is gone. The helper's LIKE ignores case, so it still lists the one that is not ours.
			expect((await codeRows()).map((each: { identifier: string }) => each.identifier)).toEqual([
				"TRACK-CONNECT:abc",
			]);
			const { results } = await track.db
				.prepare("SELECT id FROM verification WHERE id IN ('test-plain', 'test-case') ORDER BY id")
				.all<{ id: string }>();
			expect(results.map((each: { id: string }) => each.id)).toEqual(["test-case", "test-plain"]);
		} finally {
			await track.db
				.prepare("DELETE FROM verification WHERE id IN ('test-plain', 'test-case')")
				.run();
		}
	});

	it("leaves an agent that someone took over by hand before its code ran out", async () => {
		const { owner, workspaceId, slug } = await setUp("taken-over");
		await allow(owner, slug, newVerifier());
		// An admin found it in Settings and used it: its key has been used.
		await track.db
			.prepare("UPDATE agent_key SET last_used_at = ? WHERE organization_id = ?")
			.bind(Date.now(), workspaceId)
			.run();
		await expireCodes();
		await track.runScheduled();
		expect(await agentCount(workspaceId)).toBe(1);
		expect(await webhooksOf(workspaceId, owner)).toHaveLength(1);
		expect(await codeRows()).toEqual([]);
	});

	it("leaves an agent whose code was traded, and one made by hand, to a sweep", async () => {
		const { owner, workspaceId, slug } = await setUp("sweep-spares");
		const byHand = await (
			await authApi("/agents/create", owner.cookie, {
				organizationId: workspaceId,
				name: "By hand",
			})
		).json();
		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		const secrets = await exchanged(code, verifier);
		await allow(owner, slug, newVerifier());
		await expireCodes();
		await track.runScheduled();
		// The traded one and the one by hand; the untraded one is gone.
		expect(await agentCount(workspaceId)).toBe(2);
		const hooks = await webhooksOf(workspaceId, owner);
		expect(hooks.map((each) => each.agentId)).toEqual([secrets.agent.id]);
		const ids = new Set(
			((await track.directory(workspaceId)).members as { id: string; removedAt?: number }[])
				.filter((each) => !each.removedAt)
				.map((each) => each.id),
		);
		expect(ids.has(secrets.agent.id)).toBe(true);
		expect(ids.has((byHand as { agent: { id: string } }).agent.id)).toBe(true);
		// Its key still opens /mcp.
		const mcp = await mcpAs(secrets.agentKey);
		await mcp.close();
	});

	it("takes nothing back, and spends nothing, for a body of the wrong shape", async () => {
		const { owner, workspaceId, slug } = await setUp("shapeless");
		const verifier = newVerifier();
		const { code } = await allow(owner, slug, verifier);
		for (const body of [
			{ code, verifier: "short" },
			{ code },
			{ verifier },
			{ code: 1, verifier },
		]) {
			const answer = await post("/api/connect/exchange", body);
			expect(answer.status).toBe(400);
			expect(await answer.json()).toEqual(NO_CODE);
		}
		expect(await agentCount(workspaceId)).toBe(1);
		expect(await webhooksOf(workspaceId, owner)).toHaveLength(1);
		expect(await codeRows()).toHaveLength(1);
		await exchanged(code, verifier);
	});

	it("deletes a row written before the ids were readable, without an error", async () => {
		const { owner, workspaceId, slug } = await setUp("legacy");
		const strip = async () => {
			const [row] = await codeRows();
			const value = JSON.parse(row?.value ?? "{}") as Record<string, unknown>;
			// What Track 0.39.0 wrote: the challenge and the seal, nothing more.
			for (const key of Object.keys(value)) {
				if (!["v", "challenge", "iv", "ct"].includes(key)) delete value[key];
			}
			// And a row that ran out with its code, a minute on.
			await track.db
				.prepare("UPDATE verification SET value = ?, expires_at = ? WHERE identifier = ?")
				.bind(JSON.stringify(value), Date.now() + 60_000, row?.identifier)
				.run();
		};

		// The daily run: the row goes with everything else past its time, and there is nothing to
		// take back.
		await allow(owner, slug, newVerifier());
		await strip();
		await expireRows();
		await track.runScheduled();
		expect(await codeRows()).toEqual([]);
		expect(await agentCount(workspaceId)).toBe(1);

		// Refused: the same answer, and the row goes.
		const { code } = await allow(owner, slug, newVerifier());
		await strip();
		const refused = await exchange(code, newVerifier());
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual(NO_CODE);
		expect(await codeRows()).toEqual([]);
		expect(await agentCount(workspaceId)).toBe(2);
	});
});
