import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// A query of D1 that failed for good, in the Worker as it deploys (TRK-143). Drizzle's error for
// it is `Failed query: select … params: …`, with every value the statement was given. A page
// whose read failed showed it and had it in its HTML, Better Auth logged the one for a session
// read, with the session's token among the values, and what answers without a page (the sync
// gateway, a connection's exchange, the Backup entrypoint) let it into the log or to the caller.
// A table that is gone makes every read of it fail, as the database being down would.

const origin = "https://track.test";
const PASSWORD = "a-long-test-password";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

let clients = 0;
/** A client address of its own for each person, so no limit on one address gets in the way. */
const newClient = () => `203.0.113.${++clients}`;

function post(path: string, client: string, body: object, cookie?: string) {
	return track.fetch(`${origin}${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": client,
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
}

async function signUp(name: string) {
	const client = newClient();
	const email = `${name.toLowerCase()}@failure.test`;
	const response = await post("/api/auth/sign-up/email", client, {
		name,
		email,
		password: PASSWORD,
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, email, cookie, client };
}

async function createWorkspace(person: { client: string; cookie: string }, slug: string) {
	const response = await post(
		"/api/auth/organization/create",
		person.client,
		{ name: slug, slug },
		person.cookie,
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { id: string }).id;
}

/** Runs `work` with a table out of reach, and puts it back. */
async function without<Result>(table: string, work: () => Promise<Result>): Promise<Result> {
	await track.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_gone`);
	try {
		return await work();
	} finally {
		await track.db.exec(`ALTER TABLE ${table}_gone RENAME TO ${table}`);
	}
}

/** What the Worker logged since `from`, as one text. */
const loggedSince = (from: number) =>
	track.logs
		.slice(from)
		.map((log) => log.message)
		.join("\n");

/** What the Worker logged about failed queries since `from`: a kind and a reference each. */
function failuresSince(from: number) {
	return track.logs.slice(from).flatMap((log) => {
		const found = /d1: a query failed \((.+?)\), reference ([0-9a-f]{8})/.exec(log.message);
		return found ? [{ kind: found[1], reference: found[2] }] : [];
	});
}

/** The reference the error notice shows. */
const shownIn = (html: string) => /<code>([0-9a-f]{8})<\/code>/.exec(html)?.[1];

// Server functions, called as the browser does: the workspace's pages are not rendered on the
// server, so their reads fail in the answer to one of these.
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

/** Calls a GET server function with one string, or with nothing, and answers what came back. */
async function serverFn(name: string, cookie: string, data?: string) {
	// Seroval's JSON for `{ data }`.
	const value = data === undefined ? { t: 2, s: 1 } : { t: 1, s: data };
	const payload = JSON.stringify({
		t: { t: 10, i: 0, p: { k: ["data"], v: [value] }, o: 0 },
		f: 0,
		m: [],
	});
	const response = await track.fetch(
		`${serverFnUrl(name)}?payload=${encodeURIComponent(payload)}`,
		{ headers: { "x-tsr-serverFn": "true", accept: "application/json", origin, cookie } },
	);
	return { text: await response.text() };
}

describe("a page whose read of the database failed", () => {
	it("shows no statement and no values, and a reference that is in the log", async () => {
		const person = await signUp("Paige");
		const page = `${origin}/settings/account`;
		const loaded = await track.fetch(page, { headers: { cookie: person.cookie } });
		expect(loaded.status).toBe(200);

		const from = track.logs.length;
		// The page asks which sign-ins the account has, by the person's id.
		const html = await without("account", async () => {
			const response = await track.fetch(page, { headers: { cookie: person.cookie } });
			expect(response.status).toBe(500);
			return response.text();
		});

		expect(html).not.toContain("Failed query");
		expect(html).not.toContain("params");
		expect(html).not.toMatch(/select\b[^<]*\bfrom\b/i);
		expect(html).not.toContain("provider_id");
		expect(html).not.toContain(person.id);

		expect(html).toContain("This page could not be loaded.");
		const failures = failuresSince(from);
		expect(failures.length).toBeGreaterThan(0);
		for (const { kind } of failures) {
			expect(kind).toBe("D1_ERROR, SQLITE_ERROR, no such table: account");
		}
		expect(shownIn(html)).toBeDefined();
		expect(failures.map(({ reference }) => reference)).toContain(shownIn(html));
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain(person.id);
	});
});

describe("a session read that failed", () => {
	it("puts no token in the log or the page", async () => {
		const person = await signUp("Sasha");
		const signed = /session_token=([^;]+)/.exec(person.cookie)?.[1] ?? "";
		const token = decodeURIComponent(signed).split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const from = track.logs.length;
		const html = await without("session", async () => {
			const response = await track.fetch(`${origin}/`, { headers: { cookie: person.cookie } });
			expect(response.status).toBe(500);
			return response.text();
		});

		const logged = loggedSince(from);
		// Better Auth logs the failure it caught.
		expect(logged).toContain("[Better Auth]");
		expect(logged).not.toContain(token);
		expect(logged).not.toContain("Failed query");
		expect(logged).not.toContain("params");
		expect(html).not.toContain(token);
		expect(html).not.toContain("Failed query");
		expect(html).toContain("This page could not be loaded.");
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: session",
		);
		// The log has the statement that failed, with a `?` where the token was.
		expect(logged).toContain('where "session"."token" = ? limit ?');

		// Better Auth throws its own error for this, with the database's as the cause. The page
		// shows that one's reference, and the browser is sent the same, so it shows it too.
		const references = failuresSince(from).map(({ reference }) => reference);
		expect(shownIn(html)).toBeDefined();
		expect(references).toContain(shownIn(html));
		expect(html).toContain(`new Error("Failed to get session (reference ${shownIn(html)})")`);
	});
});

// `/$workspace` and everything under it is rendered in the browser only, from what server
// functions answer. So the failure reaches the page as a server function's error.
describe("a server function whose read failed", () => {
	it("answers the workspace's page with the reference and nothing of the statement", async () => {
		const person = await signUp("Wren");
		await createWorkspace(person, "failed-read-space");
		const found = await serverFn("getWorkspace", person.cookie, "failed-read-space");
		expect(found.text).toContain(person.id);

		const from = track.logs.length;
		const answer = await without("member", () =>
			serverFn("getWorkspace", person.cookie, "failed-read-space"),
		);

		// An error, which crosses as its message alone.
		expect(answer.text).toContain("$TSR/Error");
		expect(answer.text).not.toContain("Failed query");
		expect(answer.text).not.toContain("params");
		expect(answer.text).not.toContain("organization_id");
		// The membership is looked up by who is asking, so their id was among the values.
		expect(answer.text).not.toContain(person.id);
		expect(answer.text).not.toContain("failed-read-space");
		const failures = failuresSince(from);
		expect(failures.map(({ kind }) => kind)).toEqual([
			"D1_ERROR, SQLITE_ERROR, no such table: member",
		]);
		expect(answer.text).toContain(`A database query failed (reference ${failures[0]?.reference})`);
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain(person.id);
	});

	it("keeps the reference of a failed session read, which is in the error's cause", async () => {
		const person = await signUp("Tove");

		const from = track.logs.length;
		const answer = await without("session", () => serverFn("getSession", person.cookie));

		expect(answer.text).toContain("$TSR/Error");
		expect(answer.text).not.toContain("Failed query");
		const references = failuresSince(from).map(({ reference }) => reference);
		expect(references).toHaveLength(1);
		expect(answer.text).toContain(`Failed to get session (reference ${references[0]})`);
	});
});

// The gateways and entrypoints that answer without a page. None of them catches a failed query,
// so what it says is what the runtime logs for the request, and what a caller may be handed.
describe("what answers without a page", () => {
	it("the sync gateway logs no statement and no values when the membership cannot be read", async () => {
		const person = await signUp("Greta");
		await createWorkspace(person, "failed-sync-space");
		const snapshot = `${origin}/api/sync/failed-sync-space/snapshot`;
		expect((await track.fetch(snapshot, { headers: { cookie: person.cookie } })).status).toBe(200);

		const from = track.logs.length;
		const answer = await without("member", async () => {
			const response = await track.fetch(snapshot, { headers: { cookie: person.cookie } });
			return { status: response.status, text: await response.text() };
		});

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("Failed query");
		expect(answer.text).not.toContain(person.id);
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain(person.id);
		expect(failuresSince(from).map(({ kind }) => kind)).toEqual([
			"D1_ERROR, SQLITE_ERROR, no such table: member",
		]);
	});

	it("Better Auth's endpoint answers 500, and logs nothing of what it was asked to store", async () => {
		const person = await signUp("Bette");
		const slug = "a-slug-nobody-should-log";

		const from = track.logs.length;
		const answer = await without("organization", async () => {
			const response = await post(
				"/api/auth/organization/create",
				person.client,
				{ name: "Quiet", slug },
				person.cookie,
			);
			return { status: response.status, text: await response.text() };
		});

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain(slug);
		expect(answer.text).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain(slug);
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: organization",
		);
	});

	it("the MCP gateway tells an agent, and the log, no statement when its key cannot be looked up", async () => {
		const person = await signUp("Mika");
		const organizationId = await createWorkspace(person, "failed-mcp-space");
		const created = await post(
			"/api/auth/agents/create",
			person.client,
			{ organizationId, name: "Triage" },
			person.cookie,
		);
		expect(created.status).toBe(200);
		const { key } = (await created.json()) as { key: string };
		const mcp = new Client({ name: "triage", version: "1.0.0" });
		await mcp.connect(
			new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
				fetch: track.fetch,
				requestInit: { headers: { authorization: `Bearer ${key}` } },
			}),
		);
		const listed = await mcp.callTool({ name: "list_workspaces", arguments: {} });
		expect(JSON.stringify(listed)).toContain("failed-mcp-space");

		const from = track.logs.length;
		// The key is looked up by its hash on every call, which was the statement's value.
		const told = await without("agent_key", () =>
			mcp.callTool({ name: "list_workspaces", arguments: {} }).then(
				(result) => JSON.stringify(result),
				(error: unknown) => String(error),
			),
		);

		expect(told).not.toContain("failed-mcp-space");
		expect(told).not.toContain("Failed query");
		expect(told).not.toContain("params");
		expect(told).not.toMatch(/select\b.*\bfrom\b/i);
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain("params:");
		expect(failuresSince(from).map(({ kind }) => kind)).toEqual([
			"D1_ERROR, SQLITE_ERROR, no such table: agent_key",
		]);
		await mcp.close();
	});

	it("a connection's exchange logs no statement with the code's row named in it", async () => {
		const code = "c".repeat(43);
		const from = track.logs.length;
		const answer = await without("verification", async () => {
			const response = await post("/api/connect/exchange", newClient(), {
				code,
				verifier: "v".repeat(43),
			});
			return { status: response.status, text: await response.text() };
		});

		expect(answer.status).toBe(500);
		// The row is named by the code's hash, which was the statement's one value.
		expect(answer.text).not.toContain("track-connect:");
		expect(loggedSince(from)).not.toContain("track-connect:");
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(failuresSince(from).map(({ kind }) => kind)).toEqual([
			"D1_ERROR, SQLITE_ERROR, no such table: verification",
		]);
		// The delete that decides was sent once.
		expect(loggedSince(from)).not.toContain("is sent again");

		// With the table back, the code opens nothing, as before: it was never made.
		const refused = await post("/api/connect/exchange", newClient(), {
			code,
			verifier: "v".repeat(43),
		});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: "invalid_code" });
	});

	it("the Backup entrypoint hands the backup Worker the reference and no statement", async () => {
		const listed = await track.backup<{ names: string[] }>("objects");
		expect(listed.result?.names.length).toBeGreaterThan(0);

		const from = track.logs.length;
		const failed = await without("organization", () =>
			track.backup<{ names: string[] }>("objects"),
		);

		const [failure] = failuresSince(from);
		expect(failure?.kind).toBe("D1_ERROR, SQLITE_ERROR, no such table: organization");
		expect(failed).toEqual({ error: `A database query failed (reference ${failure?.reference})` });
	});
});
