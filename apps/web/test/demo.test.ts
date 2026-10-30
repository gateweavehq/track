import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Snapshot } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ISSUES, LABELS, PEOPLE, PROJECTS, TEAMS } from "../src/server/demo/sample-data";
import { startTrack } from "./track-worker";

// The public demo (TRK-11): every visitor gets a private sandbox that cleanup deletes after a
// day. The same code ships to every deployment, so it must also do nothing anywhere else.

const origin = "https://track.test";
const DAY_MS = 24 * 60 * 60 * 1000;

type Track = Awaited<ReturnType<typeof startTrack>>;

/**
 * The URL of the `startDemo` server function. TanStack Start names server functions by a hash
 * that only the built client knows, so read it from the one POST function in the login chunk.
 */
function startDemoUrl() {
	const assets = join(resolve(import.meta.dirname, ".."), "dist/client/assets");
	for (const file of readdirSync(assets).filter((name) => /^login-.*\.js$/.test(name))) {
		const match = /method:`POST`\}\)\.handler\(\w+\(`([0-9a-f]{64})`\)\)/.exec(
			readFileSync(join(assets, file), "utf8"),
		);
		if (match) return `${origin}/_serverFn/${match[1]}`;
	}
	throw new Error("Could not find the startDemo server function in the build");
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

/** Presses "Open a demo workspace" from a client address. */
async function openDemo(track: Track, client: string) {
	const response = await track.fetch(startDemoUrl(), {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": client,
			"x-tsr-serverFn": "true",
			accept: "application/json",
		},
	});
	// A server function that throws still answers 200: the error travels in the serialized body.
	const text = await response.clone().text();
	return { response, text, cookie: cookieOf(response), failed: text.includes('"k":["error"]') };
}

async function startVisitor(track: Track, client: string) {
	const { failed, text, cookie } = await openDemo(track, client);
	expect(failed, text).toBe(false);
	const slug = /acme-[a-z0-9]{6}/.exec(text)?.[0];
	if (!slug) throw new Error(`No workspace slug in ${text}`);
	return { slug, cookie };
}

function snapshot(track: Track, slug: string, cookie: string) {
	return track.fetch(`${origin}/api/sync/${slug}/snapshot`, { headers: { cookie, origin } });
}

async function session(track: Track, cookie: string) {
	const response = await track.fetch(`${origin}/api/auth/get-session`, { headers: { cookie } });
	return (await response.json()) as { user: { id: string; email: string } } | null;
}

async function count(track: Track, table: string) {
	const row = await track.db.prepare(`select count(*) as n from ${table}`).first<{ n: number }>();
	return row?.n ?? 0;
}

describe("on the demo deployment", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin, { demo: true });
	});

	afterAll(async () => {
		await track?.dispose();
	});

	it("signs the visitor in to a workspace filled with the sample data", async () => {
		const { slug, cookie } = await startVisitor(track, "203.0.113.1");

		const visitor = await session(track, cookie);
		expect(visitor?.user.email).toMatch(/^[0-9a-f-]{36}@visitors\.example\.com$/);

		const response = await snapshot(track, slug, cookie);
		expect(response.status).toBe(200);
		const data = (await response.json()) as Snapshot;
		expect(data.teams.map((team) => team.key).sort()).toEqual(Object.keys(TEAMS).sort());
		expect(data.labels).toHaveLength(Object.keys(LABELS).length);
		expect(data.issues).toHaveLength(ISSUES.length);
		expect(data.projects.map((project) => project.name).sort()).toEqual(
			Object.values(PROJECTS)
				.map((project) => project.name)
				.sort(),
		);
		expect(data.issues.some((issue) => issue.projectId !== null)).toBe(true);
		expect(data.comments.length).toBeGreaterThan(0);
		// The visitor and the four sample people.
		expect(data.members.map((member) => member.email).sort()).toEqual(
			[visitor?.user.email, ...Object.values(PEOPLE).map((person) => person.email)].sort(),
		);
		const maya = data.members.find((member) => member.email === PEOPLE.maya.email);
		expect(data.issues.some((issue) => issue.assigneeId === maya?.id)).toBe(true);
	});

	it("sends a returning visitor straight back to their sandbox", async () => {
		const { slug, cookie } = await startVisitor(track, "203.0.113.5");

		const home = await track.fetch(`${origin}/`, { headers: { cookie } });
		expect(home.status).toBe(307);
		expect(new URL(home.headers.get("location") ?? "", origin).pathname).toBe(`/${slug}`);
	});

	it("gives each visitor a workspace nobody else can read", async () => {
		const first = await startVisitor(track, "203.0.113.2");
		const second = await startVisitor(track, "203.0.113.3");
		expect(second.slug).not.toBe(first.slug);

		expect((await snapshot(track, first.slug, first.cookie)).status).toBe(200);
		expect((await snapshot(track, second.slug, second.cookie)).status).toBe(200);
		expect((await snapshot(track, first.slug, second.cookie)).status).toBe(404);
		expect((await snapshot(track, second.slug, first.cookie)).status).toBe(404);
		expect((await snapshot(track, first.slug, "")).status).toBeGreaterThanOrEqual(400);
	});

	it("keeps no attached files", async () => {
		const visitor = await startVisitor(track, "203.0.113.9");
		const workspace = await track.db
			.prepare("select id from organization where slug = ?")
			.bind(visitor.slug)
			.first<{ id: string }>();
		const upload = await track.fetch(
			`${origin}/api/files/${workspace?.id}/${crypto.randomUUID()}/notes.txt`,
			{
				method: "PUT",
				headers: { origin, cookie: visitor.cookie, "content-type": "text/plain" },
				body: "Anyone can open a demo, so nobody may store files in one.",
			},
		);
		expect(upload.status).toBe(403);
	});

	it("refuses to create or sign in to accounts over HTTP", async () => {
		const attempt = (path: string, body: object) =>
			track.fetch(`${origin}/api/auth${path}`, {
				method: "POST",
				headers: { origin, "content-type": "application/json", "cf-connecting-ip": "203.0.113.4" },
				body: JSON.stringify(body),
			});
		const credentials = { name: "Eve", email: "eve@example.com", password: "a-long-password-1" };

		expect((await attempt("/sign-up/email", credentials)).status).toBe(403);
		expect((await attempt("/sign-in/email", credentials)).status).toBe(403);
		expect((await attempt("/request-password-reset", { email: credentials.email })).status).toBe(
			403,
		);
		expect(await count(track, "\"user\" where email = 'eve@example.com'")).toBe(0);

		// The sample people have no password to guess in the first place.
		expect(
			await track.db
				.prepare("select count(*) as n from \"account\" where user_id like 'sample-%'")
				.first<{ n: number }>(),
		).toEqual({ n: 0 });
	});

	it("limits how many sandboxes one network can open", async () => {
		// Every attempt comes from a different address in the same IPv6 /64, which one visitor
		// can choose freely, so they all count together.
		const failures = [];
		for (let attempt = 1; attempt <= 21; attempt++) {
			failures.push((await openDemo(track, `2001:db8:77:1::${attempt.toString(16)}`)).failed);
		}
		expect(failures.indexOf(true)).toBe(20);

		const over = await openDemo(track, "2001:db8:77:1:ffff::1");
		expect(over.text).toContain("opened a lot of demo workspaces");
		expect(over.cookie).toBe("");
		// The next /64 is someone else.
		expect((await openDemo(track, "2001:db8:77:2::1")).failed).toBe(false);
	}, 60_000);

	it("deletes sandboxes and visitors a day old, and nothing else", async () => {
		const old = await startVisitor(track, "192.0.2.10");
		const lagging = await startVisitor(track, "192.0.2.11");
		const fresh = await startVisitor(track, "192.0.2.12");
		const oldOrg = await workspaceId(track, old.slug);
		const laggingOrg = await workspaceId(track, lagging.slug);
		const freshOrg = await workspaceId(track, fresh.slug);
		expect((await track.directory(oldOrg)).teams).toHaveLength(Object.keys(TEAMS).length);

		// Agents a visitor made go with their sandbox.
		const makeAgent = async (cookie: string, organizationId: string) => {
			const response = await track.fetch(`${origin}/api/auth/agents/create`, {
				method: "POST",
				headers: { origin, cookie, "content-type": "application/json" },
				body: JSON.stringify({ organizationId, name: "Triage" }),
			});
			expect(response.status).toBe(200);
			return ((await response.json()) as { agent: { id: string } }).agent.id;
		};
		const oldAgent = await makeAgent(old.cookie, oldOrg);
		const freshAgent = await makeAgent(fresh.cookie, freshOrg);

		const aged = Date.now() - DAY_MS - 60_000;
		const oldUser = (await session(track, old.cookie))?.user.id;
		const laggingUser = (await session(track, lagging.cookie))?.user.id;
		// One visitor is a day old along with their workspace. The other is a minute past a day
		// while their workspace, created just after them, is not yet: it must go all the same.
		await track.db.batch([
			track.db.prepare('update "user" set created_at = ? where id = ?').bind(aged, oldUser),
			track.db.prepare('update "organization" set created_at = ? where id = ?').bind(aged, oldOrg),
			track.db.prepare('update "user" set created_at = ? where id = ?').bind(aged, laggingUser),
		]);
		const samplePeople = await count(track, "\"user\" where id like 'sample-%'");
		expect(samplePeople).toBe(4);

		await track.runScheduled();

		expect(await session(track, old.cookie)).toBeNull();
		expect(await session(track, lagging.cookie)).toBeNull();
		expect((await snapshot(track, fresh.slug, fresh.cookie)).status).toBe(200);
		expect(await count(track, `"organization" where id in ('${oldOrg}','${laggingOrg}')`)).toBe(0);
		expect(await count(track, `"organization" where id = '${freshOrg}'`)).toBe(1);
		expect(
			await count(track, `"member" where organization_id in ('${oldOrg}','${laggingOrg}')`),
		).toBe(0);
		expect(await count(track, `"user" where id in ('${oldUser}','${laggingUser}')`)).toBe(0);
		expect(await count(track, "\"user\" where id like 'sample-%'")).toBe(4);
		expect(await count(track, `"user" where id = '${oldAgent}'`)).toBe(0);
		expect(await count(track, `"user" where id = '${freshAgent}'`)).toBe(1);
		// The Durable Objects were emptied, not just forgotten.
		expect((await track.directory(oldOrg)).teams).toEqual([]);
		expect((await track.directory(laggingOrg)).members).toEqual([]);
		expect((await track.directory(freshOrg)).teams).toHaveLength(Object.keys(TEAMS).length);
		expect(track.logs.some((log) => log.message.includes("demo cleanup: deleted 2 visitors"))).toBe(
			true,
		);

		// Running it again finds nothing more to do.
		const before = [await count(track, '"user"'), await count(track, '"organization"')];
		await track.runScheduled();
		expect([await count(track, '"user"'), await count(track, '"organization"')]).toEqual(before);
	});
});

describe("on any other deployment", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin);
	});

	afterAll(async () => {
		await track?.dispose();
	});

	it("starting a demo fails and creates nothing", async () => {
		const { failed, text, cookie } = await openDemo(track, "203.0.113.50");
		expect(failed).toBe(true);
		expect(text).toContain("not enabled");
		expect(cookie).toBe("");

		for (const table of ["user", "account", "session", "organization", "member", "invitation"]) {
			expect(await count(track, `"${table}"`), table).toBe(0);
		}
	});

	it("keeps ordinary sign-up and sign-in", async () => {
		const response = await track.fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { origin, "content-type": "application/json", "cf-connecting-ip": "203.0.113.51" },
			body: JSON.stringify({
				name: "Ada",
				email: "ada@example.com",
				password: "a-long-password-1",
			}),
		});
		expect(response.status).toBe(200);

		// With a workspace, `/` still lists workspaces rather than opening one, as it does
		// everywhere but the demo.
		const cookie = cookieOf(response);
		const created = await track.fetch(`${origin}/api/auth/organization/create`, {
			method: "POST",
			headers: { origin, cookie, "content-type": "application/json" },
			body: JSON.stringify({ name: "Ada's", slug: "adas" }),
		});
		expect(created.status).toBe(200);
		expect((await track.fetch(`${origin}/`, { headers: { cookie } })).status).toBe(200);
	});

	it("does not run cleanup", async () => {
		const old = Date.now() - 3 * DAY_MS;
		await track.db
			.prepare(
				'insert into "user" (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)',
			)
			.bind("visitor-lookalike", "Visitor", "someone@visitors.example.com", old, old)
			.run();

		await track.runScheduled();

		expect(await count(track, `"user" where id = 'visitor-lookalike'`)).toBe(1);
	});
});

describe("on a demo whose database already has the sample people", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin, { demo: true });
	});

	afterAll(async () => {
		await track?.dispose();
	});

	it("uses them as they are", async () => {
		// As `pnpm dev:seed` leaves a local database: the same people, under ids of its own.
		const now = Date.now();
		for (const [key, person] of Object.entries(PEOPLE)) {
			await track.db
				.prepare(
					'insert into "user" (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 1, ?, ?)',
				)
				.bind(`seeded-${key}`, person.name, person.email, now, now)
				.run();
		}

		const { slug, cookie } = await startVisitor(track, "203.0.113.60");
		const data = (await (await snapshot(track, slug, cookie)).json()) as Snapshot;
		expect(data.members.map((member) => member.id)).toEqual(
			expect.arrayContaining(Object.keys(PEOPLE).map((key) => `seeded-${key}`)),
		);
		expect(
			await count(track, `"user" where email like '%@example.com' and id like 'sample-%'`),
		).toBe(0);
	});

	it("takes back a sandbox it could not finish", async () => {
		// Make adding the sample members fail partway, after the visitor and workspace exist.
		await track.db
			.prepare(
				"create trigger refuse_members before insert on member when new.role = 'member' begin select raise(abort, 'refused for the test'); end",
			)
			.run();
		const visitors = await count(track, `"user" where email like '%@visitors.example.com'`);
		const workspaces = await count(track, '"organization"');
		try {
			const { failed, cookie } = await openDemo(track, "203.0.113.61");
			expect(failed).toBe(true);
			expect(await count(track, `"user" where email like '%@visitors.example.com'`)).toBe(visitors);
			expect(await count(track, '"organization"')).toBe(workspaces);
			expect(await session(track, cookie)).toBeNull();
		} finally {
			await track.db.prepare("drop trigger refuse_members").run();
		}
	});
});

async function workspaceId(track: Track, slug: string) {
	const row = await track.db
		.prepare('select id from "organization" where slug = ?')
		.bind(slug)
		.first<{ id: string }>();
	if (!row) throw new Error(`No workspace ${slug}`);
	return row.id;
}
