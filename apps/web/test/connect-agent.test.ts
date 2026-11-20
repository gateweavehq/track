import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import { type AuditPage, SOURCES_PER_WORKSPACE } from "@gateweave/track-protocol";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serverFunctions } from "./server-functions";
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

let boundary: ((step: string, id: string) => Promise<boolean>) | undefined;
beforeAll(async () => {
	track = await startTrack(origin, {
		vars: { CONNECT_ORIGINS: "https://known.test" },
		connectBoundary: async (step, id) => (await boundary?.(step, id)) ?? true,
	});
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

const serverFn = serverFunctions(origin, (input, init) => track.fetch(input, init), freshAddress);

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

	it("still takes back after an older Worker cleared expired verifications", async () => {
		const { owner, workspaceId, slug } = await setUp("kept-past-cleanup");
		await allow(owner, slug, newVerifier());
		await expireCodes();
		// During rollout, an older Worker may still run Better Auth’s bulk cleanup: every row
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

	it("leaves an agent whose first key was replaced by hand, though it has one unused key again", async () => {
		const { owner, workspaceId, slug } = await setUp("key-replaced");
		await allow(owner, slug, newVerifier());
		// An admin gave it a key of their own and revoked the connection's: one key, never used,
		// which only its id tells from the first.
		await track.db
			.prepare("UPDATE agent_key SET id = 'replaced-by-hand' WHERE organization_id = ?")
			.bind(workspaceId)
			.run();
		await expireCodes();
		await track.runScheduled();
		expect(await agentCount(workspaceId)).toBe(1);
		expect(await webhooksOf(workspaceId, owner)).toHaveLength(1);
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

function gate() {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		reached: entered.promise,
		resume: released.resolve,
		pause() {
			entered.resolve();
			return released.promise;
		},
	};
}

describe("connecting a source", () => {
	type Fixture = Awaited<ReturnType<typeof setUp>>;
	const sourceQuery = (verifier: string) =>
		new URLSearchParams({
			product: "guard",
			name: "Guard EU",
			return: "https://known.test/done",
			links: "https://known.test,https://reports.test",
			state: "007",
			challenge: challengeOf(verifier),
		}).toString();
	const input = (f: Fixture, verifier: string) => ({
		query: sourceQuery(verifier),
		workspace: f.slug,
		teamId: f.teamId,
		decision: "allow",
		lowestSeverity: "high",
		closeWhenCleared: true,
		assigneeId: null,
	});
	const decide = (
		f: Fixture,
		verifier: string,
		changes: Record<string, unknown> = {},
		cookie = f.owner.cookie,
	) =>
		serverFn<Approval>(
			"approveSourceConnection",
			"POST",
			{ ...input(f, verifier), ...changes },
			{ cookie },
		);
	async function approved(f: Fixture, changes: Record<string, unknown> = {}) {
		const verifier = newVerifier();
		const { result } = await decide(f, verifier, changes);
		expect(result.ok, result.message).toBe(true);
		const url = new URL(result.redirect ?? "");
		expect(url.origin + url.pathname).toBe("https://known.test/done");
		expect(url.searchParams.get("state")).toBe("007");
		const code = url.searchParams.get("code") ?? "";
		expect(code).toMatch(/^[\w-]{43}$/);
		return { code, verifier };
	}
	async function settings(f: Fixture) {
		return (
			await serverFn<{ sources: { id: string }[]; keys: { id: string; sourceId: string }[] }>(
				"getSourceSettings",
				"GET",
				f.slug,
				{ cookie: f.owner.cookie },
			)
		).result;
	}
	async function trade(f: Fixture, changes: Record<string, unknown> = {}) {
		const { code, verifier } = await approved(f, changes);
		const response = await exchange(code, verifier);
		expect(response.status).toBe(200);
		const answer = (await response.json()) as {
			sourceKey: string;
			source: { id: string };
			endpoint: string;
			undo: string;
			undoUntil: string;
		};
		return { answer, code, verifier };
	}
	const event = () =>
		JSON.stringify({
			key: "finding",
			state: "open",
			sentAt: new Date().toISOString(),
			severity: "high",
			title: "Finding",
		});
	async function rowsFor(f: Fixture) {
		const rows: { identifier: string; value: string }[] = await codeRows();
		return rows.filter((row) => JSON.parse(row.value).workspaceId === f.workspaceId);
	}
	const expire = (f: Fixture) =>
		track.db
			.prepare(
				"UPDATE verification SET value=json_set(value,'$.sweepAt',0,'$.goodUntil',0) WHERE identifier GLOB 'track-connect:*' AND json_extract(value,'$.workspaceId')=?",
			)
			.bind(f.workspaceId)
			.run();

	it.each(["agent", "source"] as const)(
		"keeps the raw %s page query through sign-in and approval",
		async (kind) => {
			const f = await setUp("raw-" + kind);
			const verifier = newVerifier();
			const params = new URLSearchParams(
				kind === "agent" ? connectQuery(verifier) : sourceQuery(verifier),
			);
			params.set("state", "1e3");
			const path = "/connect/" + kind + "?" + params;
			const login = await track.fetch(origin + path, { redirect: "manual" });
			expect(
				new URL(login.headers.get("location") ?? "", origin).searchParams.get("redirect"),
			).toBe(path);
			const headers = { cookie: f.owner.cookie };
			const continuation = await track.fetch(
				new URL(login.headers.get("location") ?? "", origin).href,
				{ headers, redirect: "manual" },
			);
			expect(new URL(continuation.headers.get("location") ?? "", origin).href).toBe(origin + path);
			for (const field of kind === "agent" ? ["name", "state"] : ["name"]) {
				const response = await track.fetch(origin + path + "&" + field + "=again", { headers });
				expect(await response.text()).toContain("The request names the same thing twice.");
			}
			const html = await (await track.fetch(origin + path, { headers })).text();
			const query = html.match(/"(\?[^"]*state=1e3[^"]*)"/)?.[1];
			expect(query).toBe("?" + params);
			if (!query) throw Error("Missing query in page data");
			const result =
				kind === "agent"
					? await approve(f.owner, query, { workspace: f.slug, decision: "cancel" })
					: await decide(f, verifier, { query, decision: "cancel" });
			expect(new URL(result.result.redirect ?? "").searchParams.get("state")).toBe("1e3");
		},
	);

	it("defaults close when cleared to the product's policy", async () => {
		const f = await setUp("source-defaults");
		for (const product of ["guard", "ci"]) {
			const query = new URLSearchParams(sourceQuery(newVerifier()));
			query.set("product", product);
			const html = await (
				await track.fetch(origin + "/connect/source?" + query, {
					headers: { cookie: f.owner.cookie },
				})
			).text();
			const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
			expect(checkbox).toBeDefined();
			expect(checkbox?.includes("checked")).toBe(product === "guard");
		}
	});

	it("gives the asking server three days to undo and the signed expiry in UTC", async () => {
		const f = await setUp("source-expiry");
		const before = Date.now();
		const { answer } = await trade(f);
		const expires = Date.parse(answer.undoUntil);
		expect(expires).toBeGreaterThanOrEqual(before + 3 * 86400_000 - 1000);
		expect(expires).toBeLessThanOrEqual(Date.now() + 3 * 86400_000);
		expect(answer.undoUntil).toBe(new Date(expires).toISOString());
		expect(Number(answer.undo.split(".").at(-2)) * 1000).toBe(expires);
		// The test Worker can receive the same request on either side of its signed deadline.
		for (const offset of [-1, 0, 1]) {
			const response = await track.fetch(origin + "/api/connect/undo", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": freshAddress(),
					"test-now": String(expires + offset),
				},
				body: JSON.stringify({ undo: answer.undo }),
			});
			expect(response.status).toBe(offset < 0 ? 200 : 400);
			expect(await response.json()).toEqual(offset < 0 ? { ok: true } : { error: "invalid_undo" });
		}
		expect((await settings(f)).sources).toHaveLength(0);
	});

	it("returns the same undo body for a retained and a removed source", async () => {
		const f = await setUp("undo-bodies");
		const kept = await trade(f);
		await serverFn(
			"changeSource",
			"POST",
			{ workspace: f.slug, action: { kind: "makeKey", id: kept.answer.source.id } },
			{ cookie: f.owner.cookie },
		);
		const removed = await trade(f);
		const a = await undo(kept.answer.undo);
		const b = await undo(removed.answer.undo);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(await a.text()).toBe(await b.text());
		expect((await settings(f)).sources).toMatchObject([{ id: kept.answer.source.id }]);
	});

	it("refuses a pending source even when its sealed answer is complete", async () => {
		const f = await setUp("pending-answer");
		const { code, verifier } = await approved(f);
		const [row] = await rowsFor(f);
		await track.db
			.prepare(
				"UPDATE verification SET value=json_set(value,'$.state','pending') WHERE identifier=?",
			)
			.bind(row?.identifier)
			.run();
		expect((await exchange(code, verifier)).status).toBe(400);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
	});

	it("hands a source key to exactly one concurrent exchange", async () => {
		const f = await setUp("source-race");
		const { code, verifier } = await approved(f);
		const responses = await Promise.all([exchange(code, verifier), exchange(code, verifier)]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
		expect((await settings(f)).keys).toHaveLength(1);
	});

	it("keeps a missing pending source recoverable when Allow stops after inserting its key", async () => {
		const f = await setUp("late-source");
		let retained = false;
		boundary = async (step) => {
			if (step === "before-create") {
				await track.runScheduled(Date.now() + 120_000);
				retained = (await rowsFor(f)).length === 1;
			}
			return step !== "before-keyCreated" && !(retained && step === "before-seal");
		};
		try {
			expect((await decide(f, newVerifier())).result.ok).toBe(false);
		} finally {
			boundary = undefined;
		}
		expect(retained).toBe(true);
		expect((await settings(f)).keys).toHaveLength(1);
		await track.runScheduled(Date.now() + 120_000);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it("a stale gone sweep leaves the exchanged key with its source", async () => {
		const f = await setUp("stale-gone");
		const creating = gate();
		const gone = gate();
		let first = true;
		boundary = async (step) => {
			if (step === "before-create") await creating.pause();
			if (step === "after-gone" && first) {
				first = false;
				await gone.pause();
			}
			return true;
		};
		try {
			const allowing = approved(f);
			await creating.reached;
			const later = Date.now() + 120_000;
			const sweepA = track.runScheduled(later);
			await gone.reached;
			await track.runScheduled(later + 600_001);
			creating.resume();
			const { code, verifier } = await allowing;
			const response = await exchange(code, verifier);
			expect(response.status).toBe(200);
			const { source, sourceKey } = (await response.json()) as {
				source: { id: string };
				sourceKey: string;
			};
			gone.resume();
			await sweepA;
			expect(await settings(f)).toMatchObject({
				sources: [{ id: source.id }],
				keys: [{ sourceId: source.id }],
			});
			expect(
				(
					await track.fetch(origin + "/api/events", {
						method: "POST",
						headers: { authorization: "Bearer " + sourceKey, "content-type": "application/json" },
						body: event(),
					})
				).status,
			).toBe(200);
			expect(await rowsFor(f)).toEqual([]);
		} finally {
			creating.resume();
			gone.resume();
			boundary = undefined;
		}
	});

	it("a sweep after the pending read fences the approval key insert", async () => {
		const f = await setUp("insert-fence");
		let reachedKey = false;
		boundary = async (step) => {
			if (step === "after-create") await track.runScheduled(Date.now() + 120_000);
			if (step === "before-keyCreated") reachedKey = true;
			return true;
		};
		try {
			expect((await decide(f, newVerifier())).result.ok).toBe(false);
		} finally {
			boundary = undefined;
		}
		expect(reachedKey).toBe(false);
		await track.runScheduled();
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it.each(["before seal", "before read", "after read"])(
		"Settings Make key %s and undo agree in both stores",
		async (ordering) => {
			const f = await setUp("make-" + ordering.replace(" ", "-"));
			const { answer } = await trade(f);
			const id = answer.source.id;
			if (ordering === "before seal") {
				await serverFn(
					"changeSource",
					"POST",
					{ workspace: f.slug, action: { kind: "pause", id, paused: true } },
					{ cookie: f.owner.cookie },
				);
				expect((await settings(f)).sources).toMatchObject([{ id, paused: true }]);
			}
			const original = await settings(f);
			const makeKey = async () =>
				(
					await serverFn<{ ok: boolean; message?: string }>(
						"changeSource",
						"POST",
						{ workspace: f.slug, action: { kind: "makeKey", id } },
						{ cookie: f.owner.cookie },
					)
				).result;
			const checked = gate();
			const inserted = gate();
			let issuing: ReturnType<typeof makeKey>;
			boundary = async (step) => {
				if (step === "after-checkKey") await checked.pause();
				if (step === "before-keyCreated" && ordering === "before read") await inserted.pause();
				if (step === "before-seal" && ordering === "before seal") {
					checked.resume();
					await issuing;
				}
				if (step === "after-sealed" && ordering === "before read") {
					checked.resume();
					await inserted.reached;
				}
				if (step === "before-finish" || step === "before-release") {
					checked.resume();
					inserted.resume();
					await issuing;
				}
				return true;
			};
			try {
				issuing = makeKey();
				await checked.reached;
				expect((await undo(answer.undo)).status).toBe(200);
				const result = await issuing;
				const after = await settings(f);
				if (ordering === "before seal") {
					expect(result.ok).toBe(true);
					expect(after.sources).toEqual(original.sources);
					expect(after.keys).toHaveLength(2);
					expect(after.keys).toEqual(expect.arrayContaining(original.keys));
				} else {
					expect(result).toMatchObject({ ok: false, message: "Source not found" });
					expect(after).toEqual(ordering === "after read" ? { sources: [], keys: [] } : original);
				}
			} finally {
				checked.resume();
				inserted.resume();
				boundary = undefined;
			}
		},
	);

	it("a durable undo claim retries the key delete after the object finished", async () => {
		const f = await setUp("durable-undo");
		const { answer } = await trade(f);
		const before = await settings(f);
		await track.db
			.prepare(
				"CREATE TRIGGER refuse_undo_delete BEFORE DELETE ON source_key BEGIN SELECT RAISE(ABORT,'test'); END",
			)
			.run();
		try {
			expect((await undo(answer.undo)).status).toBe(500);
		} finally {
			await track.db.prepare("DROP TRIGGER refuse_undo_delete").run();
		}
		expect(await settings(f)).toEqual({ sources: [], keys: before.keys });
		const claimed = await rowsFor(f);
		expect(claimed).toHaveLength(1);
		expect((await undo(answer.undo)).status).toBe(200);
		expect(await rowsFor(f)).toEqual(claimed);
		expect((await settings(f)).keys).toEqual(before.keys);
		await track.runScheduled(Date.now() + 601_000);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it("a second undo can take over an expired undo claim", async () => {
		const f = await setUp("undo-takeover");
		const { answer } = await trade(f);
		const finishing = gate();
		let first = true;
		boundary = async (step) => {
			if (step === "before-finish" && first) {
				first = false;
				await finishing.pause();
			}
			return true;
		};
		try {
			const previous = undo(answer.undo);
			await finishing.reached;
			await track.rpc(f.workspaceId, "setObjectTime", Date.now() + 601_000);
			const response = await track.fetch(origin + "/api/connect/undo", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": freshAddress(),
					"test-now": String(Date.now() + 601_000),
				},
				body: JSON.stringify({ undo: answer.undo }),
			});
			expect(response.status).toBe(200);
			expect(await settings(f)).toEqual({ sources: [], keys: [] });
			expect(await rowsFor(f)).toEqual([]);
			finishing.resume();
			expect((await previous).status).toBe(200);
		} finally {
			finishing.resume();
			boundary = undefined;
		}
	});

	async function makeSettingsKey(f: Fixture, id: string) {
		const { result } = await serverFn<{ ok: boolean; value: { secret: string } }>(
			"changeSource",
			"POST",
			{ workspace: f.slug, action: { kind: "makeKey", id } },
			{ cookie: f.owner.cookie },
		);
		expect(result.ok).toBe(true);
		return result.value.secret;
	}

	function sendEvent(secret: string, body: string) {
		return track.fetch(origin + "/api/events", {
			method: "POST",
			headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
			body,
		});
	}

	it("a delayed finish cannot delete a source sealed by a later undo", async () => {
		const f = await setUp("late-finish");
		const { answer } = await trade(f);
		const finish = gate();
		const release = gate();
		let waitForFinish = true;
		let waitForRelease = false;
		boundary = async (step) => {
			if (step === "before-finish" && waitForFinish) {
				waitForFinish = false;
				await finish.pause();
			}
			if (step === "before-release" && waitForRelease) {
				waitForRelease = false;
				await release.pause();
			}
			return true;
		};
		try {
			const stale = undo(answer.undo);
			await finish.reached;
			await track.rpc(f.workspaceId, "setObjectTime", Date.now() + 120_001);
			await makeSettingsKey(f, answer.source.id);
			const adopted = await settings(f);
			expect(adopted.keys).toHaveLength(2);
			await track.runScheduled(Date.now() + 601_000);
			expect(await rowsFor(f)).toEqual([]);
			waitForRelease = true;
			const later = undo(answer.undo);
			await release.reached;
			finish.resume();
			expect((await stale).status).toBe(200);
			release.resume();
			expect((await later).status).toBe(200);
			expect(await settings(f)).toEqual(adopted);
			expect((await sendEvent(answer.sourceKey, event())).status).toBe(200);
		} finally {
			finish.resume();
			release.resume();
			boundary = undefined;
		}
	});

	it.each([
		["exchange", false],
		["undo", false],
		["exchange", true],
		["undo", true],
	] as const)("recovers a delayed %s seal (release interrupted: %s)", async (kind, interrupted) => {
		const f = await setUp("delay-" + kind + "-" + Number(interrupted));
		const token = kind === "undo" ? (await trade(f)).answer.undo : undefined;
		const code = token === undefined ? (await approved(f)).code : undefined;
		const [source] = (await settings(f)).sources;
		if (!source) throw Error("Missing source");
		const secret = await makeSettingsKey(f, source.id);
		const sealing = gate();
		let first = true;
		let recovered = false;
		boundary = async (step) => {
			if (step === "before-seal" && first) {
				first = false;
				await sealing.pause();
			}
			return !(interrupted && recovered && step === "before-release");
		};
		try {
			const now = Date.now();
			await track.rpc(f.workspaceId, "setObjectTime", now);
			const stale = token !== undefined ? undo(token) : exchange(code ?? "", newVerifier());
			await sealing.reached;
			await track.runScheduled(now + 601_000);
			expect(await rowsFor(f)).toEqual([]);
			recovered = true;
			sealing.resume();
			await stale;
			const body = event();
			if (interrupted) {
				const sealed = await sendEvent(secret, body);
				expect(sealed.status).toBe(503);
				expect(sealed.headers.get("Retry-After")).toBe("60");
				await track.rpc(f.workspaceId, "setObjectTime", now + 120_000);
			}
			expect((await sendEvent(secret, body)).status).toBe(200);
			const unpaused = await serverFn<{ ok: boolean }>(
				"changeSource",
				"POST",
				{ workspace: f.slug, action: { kind: "pause", id: source.id, paused: false } },
				{ cookie: f.owner.cookie },
			);
			expect(unpaused.result.ok).toBe(true);
			expect((await settings(f)).keys).toHaveLength(2);
		} finally {
			sealing.resume();
			boundary = undefined;
		}
	});

	it("asks the sender to retry the same event after release", async () => {
		const f = await setUp("sealed-retry");
		const { answer } = await trade(f);
		const [key] = (await settings(f)).keys;
		if (!key) throw Error("Missing key");
		const holder = key.id + ":" + crypto.randomUUID();
		const id = key.sourceId;
		expect(await track.rpc(f.workspaceId, "removeConnectedSource", id, holder)).toBe("sealed");
		const body = event();
		const retry = await sendEvent(answer.sourceKey, body);
		expect(retry.status).toBe(503);
		expect(retry.headers.get("retry-after")).toBe("60");
		await track.rpc(f.workspaceId, "releaseConnectedSource", id, holder);
		expect((await sendEvent(answer.sourceKey, body)).status).toBe(200);
		await track.rpc(f.workspaceId, "manageSource", f.owner.id, { kind: "prepareRemoval", id });
		const settingsRemoval = await sendEvent(answer.sourceKey, body);
		expect(settingsRemoval.status).toBe(503);
		expect(settingsRemoval.headers.get("retry-after")).toBe("60");
	});

	it("sweeps a late create after rollback found the source absent", async () => {
		const f = await setUp("rollback-late-create");
		let id = "";
		let notAfter = 0;
		let keyId = "";
		boundary = async (step, sourceId) => {
			if (step !== "before-create") return true;
			id = sourceId;
			const [pending] = await rowsFor(f);
			({ sweepAt: notAfter, keyId } = JSON.parse(pending?.value ?? "{}"));
			return false;
		};
		try {
			expect((await decide(f, newVerifier())).result.ok).toBe(false);
		} finally {
			boundary = undefined;
		}
		// Deliver the interrupted RPC after the rollback has read the object as empty.
		expect(
			await track.rpc(f.workspaceId, "manageSource", f.owner.id, {
				kind: "create",
				id,
				notAfter,
				input: { teamId: f.teamId, product: "guard", name: "Guard", linkOrigins: [] },
			}),
		).toMatchObject({ ok: true });
		// Include the matching D1 key in the partial state the next sweep must reconcile.
		await track.db
			.prepare("INSERT INTO source_key(id,organization_id,source_id,hash,start) VALUES(?,?,?,?,?)")
			.bind(keyId, f.workspaceId, id, crypto.randomUUID(), "test")
			.run();
		expect(await settings(f)).toMatchObject({ sources: [{ id }], keys: [{ id: keyId }] });
		await track.runScheduled(notAfter + 1);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it("keeps the source when undo lands between the two key revocation writes", async () => {
		const f = await setUp("undo-revoked");
		const { answer } = await trade(f);
		const before = await settings(f);
		const [key] = before.keys;
		if (!key) throw Error("Missing approval key");
		expect(
			await track.rpc(f.workspaceId, "revokeSourceKey", f.owner.id, {
				kind: "prepareRevoke",
				id: key.sourceId,
				keyId: key.id,
				listed: true,
			}),
		).toMatchObject({ ok: true });
		expect((await undo(answer.undo)).status).toBe(200);
		expect(await settings(f)).toEqual(before);
	});

	it("keeps the source and its other key when Settings revokes the approval key during finish", async () => {
		const f = await setUp("revoke-during-finish");
		const { answer } = await trade(f);
		const id = answer.source.id;
		const [key] = (await settings(f)).keys;
		if (!key) throw Error("Missing approval key");
		const checked = gate();
		const inserted = gate();
		const finishing = gate();
		boundary = async (step) => {
			if (step === "after-checkKey") await checked.pause();
			if (step === "before-keyCreated") await inserted.pause();
			if (step === "before-finish") await finishing.pause();
			return true;
		};
		try {
			const issuing = makeSettingsKey(f, id);
			await checked.reached;
			const undoing = undo(answer.undo);
			await finishing.reached;
			checked.resume();
			await inserted.reached;
			const revoke = await serverFn(
				"changeSource",
				"POST",
				{
					workspace: f.slug,
					action: { kind: "revokeKey", id, keyId: key.id },
				},
				{ cookie: f.owner.cookie },
			);
			expect(revoke.result).toMatchObject({ ok: true });
			finishing.resume();
			const response = await undoing;
			inserted.resume();
			const other = await issuing;
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
			expect(await settings(f)).toMatchObject({
				sources: [{ id, paused: false }],
				keys: [{ sourceId: id }],
			});
			expect(await rowsFor(f)).toEqual([]);
			expect((await sendEvent(other, event())).status).toBe(200);
		} finally {
			checked.resume();
			inserted.resume();
			finishing.resume();
			boundary = undefined;
		}
	});

	it("retries an undo whose seal expired while it still held its D1 claim", async () => {
		const f = await setUp("undo-expired-finish");
		const { answer } = await trade(f);
		const before = await settings(f);
		const now = Date.now();
		await track.rpc(f.workspaceId, "setObjectTime", now);
		boundary = async (step) => {
			if (step === "before-finish") await track.rpc(f.workspaceId, "setObjectTime", now + 120_000);
			return true;
		};
		try {
			const response = await undo(answer.undo);
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: "try_again" });
		} finally {
			boundary = undefined;
		}
		expect(await settings(f)).toEqual(before);
		expect(await rowsFor(f)).toHaveLength(1);
		await track.runScheduled(now + 601_000);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it("measures pending grace when the sweep asks about the source", async () => {
		const f = await setUp("grace-at-ask");
		const clockOffset = (offset: number) =>
			track.fetch(origin + "/test-sweep-clock", { headers: { "test-now": String(offset) } });
		boundary = async (step) => {
			if (step === "before-create") {
				const [row] = await rowsFor(f);
				const { sweepAt } = JSON.parse(row?.value ?? "{}");
				await track.runScheduled(sweepAt + 3600_000 - 1);
			}
			if (step === "after-gone") await clockOffset(2);
			if (step === "before-keyCreated") {
				boundary = async (step) => step !== "before-seal";
				return false;
			}
			return true;
		};
		try {
			expect((await decide(f, newVerifier())).result.ok).toBe(false);
			expect(await rowsFor(f)).toHaveLength(1);
			expect((await settings(f)).keys).toHaveLength(1);
		} finally {
			await clockOffset(0);
			boundary = undefined;
		}
		await track.runScheduled(Date.now() + 120_000);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it("preserves an unfinished undo behind 200 older due rows through the daily prune", async () => {
		const f = await setUp("undo-backlog");
		const { answer } = await trade(f);
		await track.db
			.prepare(
				"CREATE TRIGGER keep_undo_key BEFORE DELETE ON source_key BEGIN SELECT RAISE(ABORT, 'test'); END",
			)
			.run();
		try {
			expect((await undo(answer.undo)).status).toBe(500);
		} finally {
			await track.db.prepare("DROP TRIGGER keep_undo_key").run();
		}
		const [row] = await rowsFor(f);
		if (!row) throw Error("Missing undo claim");
		const now = Date.now();
		await track.db
			.prepare(
				"UPDATE verification SET expires_at=?,created_at=?,value=json_set(value,'$.claimedUntil',?) WHERE identifier=?",
			)
			.bind(now - 1, now - 4 * 86400_000, now - 86400_000, row.identifier)
			.run();
		await track.db
			.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<200)
			INSERT INTO verification(id,identifier,value,created_at,expires_at)
			SELECT 'backlog-'||i,'track-connect:backlog-'||i,'{}',?,? FROM n`)
			.bind(now - 5 * 86400_000, now - 2 * 86400_000)
			.run();
		const lookup = await track.fetch(
			origin + "/api/auth/reset-password/unused?callbackURL=" + encodeURIComponent(origin),
			{ redirect: "manual", headers: { "test-now": String(now + 86400_000) } },
		);
		expect(lookup.headers.get("location")).toContain("INVALID_TOKEN");
		expect(await rowsFor(f)).toHaveLength(1);
		await track.runScheduled();
		expect(await rowsFor(f)).toHaveLength(1);
		await track.runScheduled();
		expect(await rowsFor(f)).toEqual([]);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
	});

	it("leaves a competing claim for a later sweep and refuses an expired finish", async () => {
		const f = await setUp("lease-busy");
		const { answer } = await trade(f);
		const id = answer.source.id;
		const now = Date.now();
		await track.rpc(f.workspaceId, "setObjectTime", now);
		await track.rpc(f.workspaceId, "manageSource", f.owner.id, { kind: "pause", id, paused: true });
		const holder = "another-claim";
		expect(await track.rpc(f.workspaceId, "removeConnectedSource", id, holder)).toBe("sealed");
		expect((await undo(answer.undo)).status).toBe(200);
		expect(await rowsFor(f)).toHaveLength(1);
		await track.rpc(f.workspaceId, "setObjectTime", now + 120_000);
		expect(await track.rpc(f.workspaceId, "finishConnectedSourceRemoval", id, holder, "undo")).toBe(
			"notHeld",
		);
		expect((await settings(f)).sources).toMatchObject([{ id, paused: true }]);
		const unpaused = await track.rpc(f.workspaceId, "manageSource", f.owner.id, {
			kind: "pause",
			id,
			paused: false,
		});
		expect(unpaused).toMatchObject({ ok: true, value: { paused: false } });
		await track.runScheduled(now + 601_000);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it("discards a 30-day-old connect row with a future deadline and logs only its ids", async () => {
		const f = await setUp("age-limit");
		await approved(f);
		const [row] = await rowsFor(f);
		if (!row) throw Error("Missing approval");
		const made = JSON.parse(row.value);
		await track.db
			.prepare("UPDATE verification SET created_at=? WHERE identifier=?")
			.bind(Date.now() - 31 * 86400_000, row.identifier)
			.run();
		const from = track.logs.length;
		await track.runScheduled();
		expect(await rowsFor(f)).toEqual([]);
		const [log] = track.logs
			.slice(from)
			.filter((log) => log.message.startsWith("connect: expired after 30 days"));
		expect(log?.message).toContain(made.sourceId);
		expect(log?.message).toContain(made.keyId);
		expect(log?.message).not.toContain(made.ct);
		expect(log?.message).not.toContain(made.origin);
	});

	it.each(["replacement", "original"])(
		"stale cleanup preserves a reclaimed agent with its %s key and webhooks",
		async (remaining) => {
			const f = await setUp("stale-agent-" + remaining);
			await allow(f.owner, f.slug, newVerifier());
			const hooks = await webhooksOf(f.workspaceId, f.owner);
			expect(hooks).toHaveLength(1);
			await expire(f);
			const [approval] = await rowsFor(f);
			const { keyId } = JSON.parse(approval?.value ?? "{}");
			const replacement = crypto.randomUUID();
			const claimed = gate();
			let first = true;
			boundary = async (step) => {
				if (step === "after-workspace-check" && first) {
					first = false;
					await claimed.pause();
				}
				return true;
			};
			const now = Date.now();
			const stale = track.runScheduled(now);
			try {
				await claimed.reached;
				await track.db
					.prepare(
						"INSERT INTO agent_key(id,user_id,organization_id,start,hash,created_at) SELECT ?,user_id,organization_id,start,?,created_at FROM agent_key WHERE id=?",
					)
					.bind(replacement, crypto.randomUUID(), keyId)
					.run();
				if (remaining === "replacement")
					await track.db.prepare("DELETE FROM agent_key WHERE id=?").bind(keyId).run();
				await track.runScheduled(now + 600_001);
				expect(await rowsFor(f)).toEqual([]);
				// If the admin discards the additional key, only claim ownership still protects the agent.
				if (remaining === "original")
					await track.db.prepare("DELETE FROM agent_key WHERE id=?").bind(replacement).run();
				claimed.resume();
				await stale;
				expect(await agentCount(f.workspaceId)).toBe(1);
				expect(
					await track.db
						.prepare("SELECT id FROM agent_key WHERE organization_id=?")
						.bind(f.workspaceId)
						.first(),
				).toEqual({ id: remaining === "replacement" ? replacement : keyId });
				expect(await webhooksOf(f.workspaceId, f.owner)).toEqual(hooks);
			} finally {
				claimed.resume();
				boundary = undefined;
			}
		},
	);

	it("records one agent deletion when webhook removal fails and the sweep retries", async () => {
		const f = await setUp("agent-audit-retry");
		await allow(f.owner, f.slug, newVerifier());
		const [hook] = await webhooksOf(f.workspaceId, f.owner);
		if (!hook?.agentId) throw Error("Missing agent webhook");
		await expire(f);
		boundary = async (step) => step !== "before-removeConnectedWebhooksOf";
		try {
			await track.runScheduled();
		} finally {
			boundary = undefined;
		}
		expect(await agentCount(f.workspaceId)).toBe(0);
		expect(await webhooksOf(f.workspaceId, f.owner)).toEqual([hook]);
		await track.runScheduled(Date.now() + 3601_000);
		expect(await webhooksOf(f.workspaceId, f.owner)).toEqual([]);
		expect(await rowsFor(f)).toEqual([]);
		const deleted = (await auditOf(f.workspaceId, f.owner)).filter(
			(entry) => entry.action === "agent.deleted",
		);
		expect(deleted).toMatchObject([{ target: { id: hook.agentId } }]);
	});

	it("a zero-key agent retry finishes the membership sync", async () => {
		const f = await setUp("zero-key-retry");
		await allow(f.owner, f.slug, newVerifier());
		const [row] = await rowsFor(f);
		const { agentId } = JSON.parse(row?.value ?? "{}");
		boundary = async (step) => step !== "before-removeMember";
		try {
			await expire(f);
			await track.runScheduled();
		} finally {
			boundary = undefined;
		}
		expect(await agentCount(f.workspaceId)).toBe(0);
		expect((await directoryAgent(f.workspaceId, agentId))?.removedAt).toBeNull();
		expect(await webhooksOf(f.workspaceId, f.owner)).toHaveLength(1);
		await track.runScheduled(Date.now() + 3601_000);
		expect((await directoryAgent(f.workspaceId, agentId))?.removedAt).toBeGreaterThan(0);
		expect(await webhooksOf(f.workspaceId, f.owner)).toEqual([]);
		expect(await rowsFor(f)).toEqual([]);
	});

	it("exchanges historical agent ciphertext with neither kind field", async () => {
		const f = await setUp("historical-code");
		const verifier = newVerifier();
		const { code } = await allow(f.owner, f.slug, verifier);
		const [row] = await rowsFor(f);
		if (!row) throw Error("Missing code");
		const outer = JSON.parse(row.value);
		const purpose = "track-connect-code-v1";
		const key = Buffer.from(hkdfSync("sha256", track.authSecret, code, purpose, 32));
		const aad = Buffer.from([purpose, row.identifier, outer.challenge].join(":"));
		const ciphertext = Buffer.from(outer.ct, "base64url");
		const decrypt = createDecipheriv("aes-256-gcm", key, Buffer.from(outer.iv, "base64url"));
		decrypt.setAAD(aad);
		decrypt.setAuthTag(ciphertext.subarray(-16));
		const inner = JSON.parse(
			Buffer.concat([decrypt.update(ciphertext.subarray(0, -16)), decrypt.final()]).toString(),
		);
		delete inner.kind;
		delete outer.kind;
		const iv = randomBytes(12);
		const encrypt = createCipheriv("aes-256-gcm", key, iv);
		encrypt.setAAD(aad);
		outer.iv = iv.toString("base64url");
		outer.ct = Buffer.concat([
			encrypt.update(JSON.stringify(inner)),
			encrypt.final(),
			encrypt.getAuthTag(),
		]).toString("base64url");
		await track.db
			.prepare("UPDATE verification SET value=? WHERE identifier=?")
			.bind(JSON.stringify(outer), row.identifier)
			.run();
		const { returnOrigin: _origin, ...answer } = inner;
		expect(await exchanged(code, verifier)).toEqual(answer);
	});

	it.each(["spent", "claimedUntil"])("refuses a ready code with only %s set", async (field) => {
		const f = await setUp("refuse-" + field.toLowerCase());
		const { code, verifier } = await approved(f);
		const [row] = await rowsFor(f);
		await track.db
			.prepare("UPDATE verification SET value=json_set(value,?,1) WHERE identifier=?")
			.bind("$." + field, row?.identifier)
			.run();
		const before = await rowsFor(f);
		const response = await exchange(code, verifier);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual(NO_CODE);
		expect(await rowsFor(f)).toEqual(before);
		await expire(f);
		await track.runScheduled();
	});

	it("renews D1 retention when the sweep claims a row", async () => {
		const f = await setUp("claim-retention");
		await approved(f);
		const [row] = await rowsFor(f);
		await expire(f);
		await track.db
			.prepare("UPDATE verification SET expires_at=1 WHERE identifier=?")
			.bind(row?.identifier)
			.run();
		boundary = async (step) => step !== "before-seal";
		const now = Date.now();
		try {
			await track.runScheduled(now);
		} finally {
			boundary = undefined;
		}
		const kept = await track.db
			.prepare("SELECT expires_at FROM verification WHERE identifier=?")
			.bind(row?.identifier)
			.first<{ expires_at: number }>();
		expect(kept?.expires_at).toBeGreaterThanOrEqual(now + 3 * 86400_000);
		await track.runScheduled(now + 601_000);
	});

	it("cleans only the approval key inserted after Settings deleted the source", async () => {
		const f = await setUp("source-gone");
		const other = crypto.randomUUID();
		let removed = false;
		boundary = async (step, id) => {
			if (step === "after-create") {
				const answer = await serverFn<{ ok: boolean }>(
					"changeSource",
					"POST",
					{ workspace: f.slug, action: { kind: "delete", id } },
					{ cookie: f.owner.cookie },
				);
				removed = answer.result.ok;
				await track.db
					.prepare(
						"INSERT INTO source_key(id, organization_id, source_id, hash, start) VALUES(?,?,?,?,?)",
					)
					.bind(other, f.workspaceId, id, crypto.randomUUID(), "other")
					.run();
			}
			return true;
		};
		try {
			expect((await decide(f, newVerifier())).result.ok).toBe(false);
		} finally {
			boundary = undefined;
		}
		expect(removed).toBe(true);
		await expire(f);
		await track.runScheduled();
		const rows = await track.db
			.prepare("SELECT id FROM source_key WHERE organization_id=?")
			.bind(f.workspaceId)
			.all();
		expect(rows.results).toEqual([{ id: other }]);
		expect(await rowsFor(f)).toEqual([]);
	});

	it("retains an adopted source when assignment fails during Allow", async () => {
		const f = await setUp("source-adopted");
		const admin = await signUp("Second source admin");
		await addMember(f.workspaceId, admin, "admin");
		await track.rpc(f.workspaceId, "syncMember", profile(admin, "admin"));
		let eventStatus = 0;
		boundary = async (step, id) => {
			if (step === "before-assign") {
				const { result } = await serverFn<{ ok: boolean; value: { secret: string } }>(
					"changeSource",
					"POST",
					{ workspace: f.slug, action: { kind: "makeKey", id } },
					{ cookie: admin.cookie },
				);
				const accepted = await track.fetch(origin + "/api/events", {
					method: "POST",
					headers: {
						authorization: "Bearer " + result.value.secret,
						"content-type": "application/json",
						"cf-connecting-ip": freshAddress(),
					},
					body: event(),
				});
				eventStatus = accepted.status;
			}
			return true;
		};
		try {
			expect((await decide(f, newVerifier(), { assigneeId: f.owner.id })).result.ok).toBe(false);
		} finally {
			boundary = undefined;
		}
		expect(eventStatus).toBe(200);
		await expire(f);
		await track.runScheduled();
		const after = await settings(f);
		expect(after.sources).toHaveLength(1);
		expect(after.keys).toHaveLength(2);
		expect(
			(
				await track.rpc<{ signals: unknown[] }>(
					f.workspaceId,
					"snapshot",
					profile(f.owner, "owner"),
				)
			).signals,
		).toHaveLength(1);
		expect(await rowsFor(f)).toEqual([]);
	});

	it.each(["pending", "ready"] as const)(
		"checks the %s key set again on its own seal",
		async (state) => {
			const f = await setUp("key-set-" + state);
			await approved(f);
			const [row] = await rowsFor(f);
			const [key] = (await settings(f)).keys;
			if (!row || !key) throw Error("Missing approval");
			if (state === "pending")
				await track.db
					.prepare(
						"UPDATE verification SET value=json_set(value,'$.state','pending') WHERE identifier=?",
					)
					.bind(row.identifier)
					.run();
			await expire(f);
			const observed: { before?: Awaited<ReturnType<typeof settings>> } = {};
			boundary = async (step) => {
				if (step !== "before-seal") return true;
				boundary = undefined;
				const [claim] = await rowsFor(f);
				const holder = key.id + ":" + JSON.parse(claim?.value ?? "{}").claimNonce;
				expect(await track.rpc(f.workspaceId, "removeConnectedSource", key.sourceId, holder)).toBe(
					"sealed",
				);
				if (state === "ready")
					await track.db.prepare("DELETE FROM source_key WHERE id=?").bind(key.id).run();
				else
					await track.db
						.prepare(
							"INSERT INTO source_key(id,organization_id,source_id,hash,start) VALUES(?,?,?,?,?)",
						)
						.bind(crypto.randomUUID(), f.workspaceId, key.sourceId, crypto.randomUUID(), "another")
						.run();
				observed.before = await settings(f);
				return true;
			};
			try {
				await track.runScheduled();
			} finally {
				boundary = undefined;
			}
			const { before } = observed;
			if (!before) throw Error("Sweep did not reach the seal");
			expect(await rowsFor(f)).toHaveLength(0);
			expect(await settings(f)).toEqual({
				...before,
				sources: before.sources.map((source) => ({ ...source, paused: false })),
			});
		},
	);

	it("finishes a pending rollback after its D1 key was deleted", async () => {
		const f = await setUp("rollback-finish");
		boundary = async (step) => step !== "before-finish";
		try {
			expect((await decide(f, newVerifier(), { assigneeId: f.owner.id })).result.ok).toBe(false);
		} finally {
			boundary = undefined;
		}
		expect(await settings(f)).toMatchObject({ sources: [{ paused: true }], keys: [] });
		expect(await rowsFor(f)).toHaveLength(1);
		await track.rpc(f.workspaceId, "setObjectTime", Date.now() + 121_000);
		await expire(f);
		await track.runScheduled();
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it.each(["sweep", "refusal"])(
		"recovers an interrupted %s claim after its lease",
		async (reason) => {
			const f = await setUp("claim-" + reason);
			const { code, verifier } = await approved(f);
			let atSeal: { claimedUntil: number; spent?: boolean } | undefined;
			boundary = async (step) => {
				if (step !== "before-seal") return true;
				const [row] = await rowsFor(f);
				atSeal = JSON.parse(row?.value ?? "{}");
				return false;
			};
			const before = Date.now();
			try {
				if (reason === "sweep") {
					await expire(f);
					await track.runScheduled();
				} else expect((await exchange(code, newVerifier())).status).toBe(400);
			} finally {
				boundary = undefined;
			}
			expect(atSeal?.claimedUntil).toBeGreaterThanOrEqual(before + 600_000);
			expect(atSeal?.claimedUntil).toBeLessThanOrEqual(Date.now() + 600_000);
			if (reason === "refusal") expect(atSeal?.spent).toBe(true);
			expect((await exchange(code, verifier)).status).toBe(400);
			await track.runScheduled();
			expect((await settings(f)).sources).toHaveLength(1);
			const [row] = await rowsFor(f);
			await track.db
				.prepare(
					"UPDATE verification SET value=json_set(value,'$.claimedUntil',1,'$.sweepAt',0) WHERE identifier=?",
				)
				.bind(row?.identifier)
				.run();
			expect((await exchange(code, verifier)).status).toBe(400);
			await track.runScheduled();
			expect(await settings(f)).toEqual({ sources: [], keys: [] });
			expect(await rowsFor(f)).toEqual([]);
		},
	);

	it("offers the named source, binds its agent and team, and hands the key out once", async () => {
		const f = await setUp("source-offer");
		const agent = (await (
			await authApi("/agents/create", f.owner.cookie, {
				organizationId: f.workspaceId,
				name: "Reviewer",
			})
		).json()) as { agent: { id: string } };
		const cookie = f.owner.cookie;
		const query = sourceQuery(newVerifier());
		const page = await track.fetch(`${origin}/connect/source?${query}`, { headers: { cookie } });
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("a known address, not verified as the named product");
		expect(html).toContain("lead away from the asking address");
		expect(
			(await serverFn("getSourceConnectOffer", "GET", query, { cookie })).result,
		).toMatchObject({
			ok: true,
			asker: "https://known.test",
			known: true,
			product: "guard",
			name: "Guard EU",
			otherLinkOrigins: ["https://reports.test"],
			workspaces: [{ slug: f.slug }],
		});
		expect(
			(await serverFn("getSourceConnectChoices", "GET", f.slug, { cookie })).result,
		).toMatchObject({
			agents: [{ id: agent.agent.id }],
			teams: expect.arrayContaining([expect.objectContaining({ id: f.teamId })]),
		});
		const { answer, code, verifier } = await trade(f, { assigneeId: agent.agent.id });
		expect(answer).toEqual({
			sourceKey: expect.stringMatching(/^gws_[\w-]{43}$/),
			endpoint: origin + "/api/events",
			source: { id: expect.any(String), name: "Guard EU", product: "guard" },
			workspace: { id: f.workspaceId, slug: f.slug, name: f.slug },
			team: { id: f.teamId, key: "ENG", name: "Engineering" },
			undoUntil: expect.any(String),
			undo: expect.any(String),
		});
		expect(await settings(f)).toMatchObject({
			sources: [
				{
					id: answer.source.id,
					assigneeId: agent.agent.id,
					lowestSeverity: "high",
					closeWhenCleared: true,
				},
			],
			keys: [{ sourceId: answer.source.id }],
		});
		expect(await auditOf(f.workspaceId, f.owner)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "source.connected",
					actorId: f.owner.id,
					detail: { origin: "https://known.test" },
				}),
			]),
		);
		expect((await exchange(code, verifier)).status).toBe(400);
		expect((await undo(answer.undo)).status).toBe(200);
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await agentCount(f.workspaceId)).toBe(1);
	});

	it("cancels, and refuses a member, a missing session, a foreign Origin and the demo", async () => {
		const f = await setUp("source-access");
		const v = newVerifier();
		expect((await decide(f, v, { decision: "cancel" })).result).toEqual({
			ok: true,
			redirect: "https://known.test/done?error=denied&state=007",
		});
		const member = await signUp("Source member");
		await addMember(f.workspaceId, member, "member");
		for (const cookie of [member.cookie, ""]) {
			expect((await decide(f, v, {}, cookie)).result.ok).toBe(false);
			expect(
				(await serverFn("getSourceConnectChoices", "GET", f.slug, { cookie })).result,
			).toBeNull();
		}
		const foreign = await serverFn<Approval>("approveSourceConnection", "POST", input(f, v), {
			cookie: f.owner.cookie,
			from: asker,
		});
		expect(foreign.status === 403 || foreign.result?.ok === false).toBe(true);
		const demo = await startTrack(origin, { demo: true });
		try {
			const fn = serverFunctions(origin, demo.fetch, freshAddress);
			expect(
				(await fn<Approval>("approveSourceConnection", "POST", input(f, v))).result.message,
			).toMatch(/does not accept source events/);
		} finally {
			await demo.dispose();
		}
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it.each(["event", "second key"] as const)("undo leaves a source after %s", async (because) => {
		const f = await setUp("source-kept-" + because.replace(" ", "-"));
		const { answer } = await trade(f);
		if (because === "event") {
			const accepted = await track.fetch(answer.endpoint, {
				method: "POST",
				headers: {
					authorization: "Bearer " + answer.sourceKey,
					"content-type": "application/json",
					"cf-connecting-ip": freshAddress(),
				},
				body: event(),
			});
			expect(accepted.status).toBe(200);
		} else {
			expect(
				(
					await serverFn(
						"changeSource",
						"POST",
						{ workspace: f.slug, action: { kind: "makeKey", id: answer.source.id } },
						{ cookie: f.owner.cookie },
					)
				).result,
			).toMatchObject({ ok: true });
		}
		expect((await undo(answer.undo)).status).toBe(200);
		const after = await settings(f);
		expect(after.sources).toHaveLength(1);
		expect(after.keys).toHaveLength(because === "event" ? 1 : 2);
	});

	it("requires the matching purpose for both undo token formats", async () => {
		const f = await setUp("source-purpose");
		const { answer } = await trade(f);
		const v = newVerifier();
		const agent = await exchanged((await allow(f.owner, f.slug, v)).code, v);
		for (const [token, purpose] of [
			[answer.undo, "track-connect-undo-v1"],
			[agent.undo, "track-connect-source-undo-v1"],
		] as const) {
			const parts = token.split(".").slice(0, -1);
			const key = hkdfSync("sha256", Buffer.from(track.authSecret), Buffer.alloc(0), purpose, 64);
			const signature = createHmac("sha256", Buffer.from(key))
				.update([purpose, ...parts].join(":"))
				.digest("base64url");
			const response = await undo([...parts, signature].join("."));
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_undo" });
		}
		expect((await settings(f)).sources).toHaveLength(1);
		expect(await agentCount(f.workspaceId)).toBe(1);
	});

	it("sweeps unused source codes, retaining a source that received an event", async () => {
		const f = await setUp("source-sweep");
		await approved(f);
		const [first] = (await settings(f)).keys;
		if (!first) throw new Error("Missing key");
		expect(
			await track.rpc(
				f.workspaceId,
				"sourceEvent",
				first.sourceId,
				first.id,
				event(),
				origin + "/" + f.slug,
			),
		).toMatchObject({ status: 200 });
		await approved(f);
		await expire(f);
		await track.runScheduled();
		expect(await settings(f)).toMatchObject({
			sources: [{ id: first.sourceId }],
			keys: [{ id: first.id }],
		});
		expect(await rowsFor(f)).toEqual([]);
	});

	it("dispatches take-back by kind, including older agent rows without a kind", async () => {
		const f = await setUp("source-kind");
		const agent = await allow(f.owner, f.slug, newVerifier());
		const source = await approved(f);
		const [key] = (await settings(f)).keys;
		const rows = await rowsFor(f);
		const agentRow = rows.find((r) => JSON.parse(r.value).kind === "agent");
		const sourceRow = rows.find((r) => JSON.parse(r.value).kind === "source");
		if (!key || !agentRow || !sourceRow) throw new Error("Missing approvals");
		const agentId = JSON.parse(agentRow.value).agentId as string;
		await track.db
			.prepare("UPDATE verification SET value=json_set(value,'$.agentId',?) WHERE identifier=?")
			.bind(agentId, sourceRow.identifier)
			.run();
		expect((await exchange(source.code, newVerifier())).status).toBe(400);
		expect(await agentCount(f.workspaceId)).toBe(1);
		await approved(f);
		const [remaining] = (await settings(f)).keys;
		if (!remaining) throw new Error("Missing second source");
		await track.db
			.prepare(
				"UPDATE verification SET value=json_set(json_remove(value,'$.kind'),'$.sourceId',?,'$.state','pending') WHERE identifier=?",
			)
			.bind(remaining.sourceId, agentRow.identifier)
			.run();
		expect((await exchange(agent.code, newVerifier())).status).toBe(400);
		expect(await agentCount(f.workspaceId)).toBe(0);
		expect((await settings(f)).sources).toMatchObject([{ id: remaining.sourceId }]);
	});

	it.each(["without key", "with key", "before create"] as const)(
		"recovers a pending approval %s",
		async (stage) => {
			const f = await setUp("source-pending-" + stage.replace(" ", "-"));
			const { code, verifier } = await approved(f);
			const [row] = await rowsFor(f);
			if (!row) throw new Error("Missing approval");
			const { kind, workspaceId, sourceId, keyId, origin } = JSON.parse(row.value);
			if (stage === "before create") {
				await serverFn(
					"changeSource",
					"POST",
					{ workspace: f.slug, action: { kind: "delete", id: sourceId } },
					{ cookie: f.owner.cookie },
				);
			} else if (stage === "without key") {
				await track.db.prepare("DELETE FROM source_key WHERE id=?").bind(keyId).run();
			}
			await track.db
				.prepare("UPDATE verification SET value=? WHERE identifier=?")
				.bind(
					JSON.stringify({
						kind,
						workspaceId,
						sourceId,
						keyId,
						origin,
						state: "pending",
						goodUntil: 0,
						sweepAt: 0,
					}),
					row.identifier,
				)
				.run();
			if (stage === "with key") {
				const refused = await exchange(code, verifier);
				expect(refused.status).toBe(400);
				expect(await refused.json()).toEqual(NO_CODE);
			} else await track.runScheduled();
			expect(await rowsFor(f)).toEqual([]);
			expect(await settings(f)).toEqual({ sources: [], keys: [] });
		},
	);

	it("rolls back a refusal writing the pending row, issuing the key, assigning or marking ready", async () => {
		const f = await setUp("source-rollback");
		const attempt = () => decide(f, newVerifier());
		const clean = async (response: Awaited<ReturnType<typeof attempt>>) => {
			expect(response.result.ok).toBe(false);
			expect(await settings(f)).toEqual({ sources: [], keys: [] });
			expect(await rowsFor(f)).toEqual([]);
		};
		await clean(await breaking("verification", "NEW.identifier GLOB 'track-connect:*'", attempt));
		await clean(await breaking("source_key", "1", attempt));
		await clean(await decide(f, newVerifier(), { assigneeId: f.owner.id }));
		await track.db
			.prepare(
				"CREATE TRIGGER refuse_ready BEFORE UPDATE ON verification WHEN NEW.identifier GLOB 'track-connect:*' BEGIN SELECT RAISE(ABORT,'broken for a test'); END",
			)
			.run();
		try {
			await clean(await attempt());
		} finally {
			await track.db.prepare("DROP TRIGGER refuse_ready").run();
		}
	});

	it("leaves existing sources alone when the object refuses creation", async () => {
		const f = await setUp("source-full");
		for (let i = 0; i < SOURCES_PER_WORKSPACE; i++) {
			expect(
				await track.rpc(f.workspaceId, "manageSource", f.owner.id, {
					kind: "create",
					input: { teamId: f.teamId, product: "ci", name: "Build", linkOrigins: [] },
				}),
			).toMatchObject({ ok: true });
		}
		const before = await settings(f);
		expect((await decide(f, newVerifier())).result.ok).toBe(false);
		expect(await settings(f)).toEqual(before);
		expect(await rowsFor(f)).toEqual([]);
	});

	it("finishes an Allow rollback interrupted after the admin seal", async () => {
		const f = await setUp("source-interrupted");
		await track.db
			.prepare(
				"CREATE TRIGGER keep_key BEFORE DELETE ON source_key BEGIN SELECT RAISE(ABORT,'broken for a test'); END",
			)
			.run();
		try {
			expect((await decide(f, newVerifier(), { assigneeId: f.owner.id })).result.ok).toBe(false);
			expect((await settings(f)).sources).toMatchObject([{ paused: true }]);
			expect(await rowsFor(f)).toHaveLength(1);
		} finally {
			await track.db.prepare("DROP TRIGGER keep_key").run();
		}
		await track.rpc(f.workspaceId, "setObjectTime", Date.now() + 121_000);
		await expire(f);
		await track.runScheduled();
		expect(await settings(f)).toEqual({ sources: [], keys: [] });
		expect(await rowsFor(f)).toEqual([]);
	});

	it("charges the same person's agent and source approvals to one allowance", async () => {
		const f = await setUp("source-allowance");
		await allow(f.owner, f.slug, newVerifier());
		for (let i = 0; i < 9; i++) await approved(f);
		expect((await decide(f, newVerifier())).result).toMatchObject({
			ok: false,
			message: expect.stringMatching(/too often/),
		});
		expect(
			(await approve(f.owner, connectQuery(newVerifier()), { workspace: f.slug })).result,
		).toMatchObject({ ok: false, message: expect.stringMatching(/too often/) });
	});
});
