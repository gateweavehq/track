import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	cycleState,
	isActiveIssue,
	type MutationInput,
	PROTOCOL_VERSION,
	type ServerMessage,
	type Snapshot,
} from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT,
	AGENT_EXAMPLE,
	ISSUES,
	LABELS,
	PEOPLE,
	PROJECTS,
	TEAMS,
} from "../src/server/demo/sample-data";
import { startTrack } from "./track-worker";

// The public demo (TRK-11): every visitor gets a private sandbox that cleanup deletes after a
// day. The same code ships to every deployment, so it must also do nothing anywhere else.

const origin = "https://track.test";
const DAY_MS = 24 * 60 * 60 * 1000;

type Track = Awaited<ReturnType<typeof startTrack>>;

/**
 * The URL of the `startDemo` server function. TanStack Start names server functions by a hash
 * that only the built client knows, so read it from the one POST function in the chunk of
 * `lib/demo.ts`, which the opening screen loads when a visitor presses the button.
 */
function startDemoUrl() {
	const assets = join(resolve(import.meta.dirname, ".."), "dist/client/assets");
	for (const file of readdirSync(assets).filter((name) => /^demo-.*\.js$/.test(name))) {
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

async function read(track: Track, slug: string, cookie: string) {
	const response = await snapshot(track, slug, cookie);
	expect(response.status).toBe(200);
	return (await response.json()) as Snapshot;
}

/** The sample's agent in a sandbox, the issue it worked on, and the proposals open on that issue. */
function agentExample(data: Snapshot) {
	const agent = data.members.find((member) => member.role === "agent");
	const issue = data.issues.find((issue) => issue.title === AGENT_EXAMPLE.issue.title);
	if (!agent || !issue) throw new Error("The sandbox has no agent, or no issue it worked on");
	return {
		agent,
		issue,
		proposals: data.proposals.filter((proposal) => proposal.issueId === issue.id),
	};
}

/** The user ids of a workspace's agent members, as D1 has them. */
async function agentIds(track: Track, organizationId: string) {
	const { results } = await track.db
		.prepare(`select user_id from "member" where organization_id = ? and role = 'agent'`)
		.bind(organizationId)
		.all();
	return (results as { user_id: string }[]).map((row) => row.user_id);
}

/**
 * Sends one mutation as the visitor's browser does, over the sync socket their cookie opens, and
 * waits for the server's answer to it.
 */
async function mutate(track: Track, slug: string, cookie: string, mutation: MutationInput) {
	const { status, ws } = await track.socket(`${origin}/api/sync/${slug}/socket`, {
		origin,
		cookie,
	});
	expect(status).toBe(101);
	if (!ws) throw new Error("No socket");
	const id = crypto.randomUUID();
	const answered = new Promise<ServerMessage>((resolve) => {
		ws.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || !event.data.startsWith("{")) return;
			const message = JSON.parse(event.data) as ServerMessage;
			if ((message.type === "ack" || message.type === "reject") && message.id === id) {
				resolve(message);
			}
		});
	});
	ws.send(
		JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "tab-1", since: 0 }),
	);
	ws.send(JSON.stringify({ type: "mutate", id, mutation }));
	const answer = await answered;
	ws.close(1000);
	return answer;
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
		// The listed issues, and the one the sample's agent worked on.
		expect(data.issues).toHaveLength(ISSUES.length + 1);
		expect(data.projects.map((project) => project.name).sort()).toEqual(
			Object.values(PROJECTS)
				.map((project) => project.name)
				.sort(),
		);
		expect(data.issues.some((issue) => issue.projectId !== null)).toBe(true);
		expect(data.comments.length).toBeGreaterThan(0);
		// The visitor and the four sample people. The sample's agent is the only other member.
		const persons = data.members.filter((member) => member.role !== "agent");
		expect(persons.map((member) => member.email).sort()).toEqual(
			[visitor?.user.email, ...Object.values(PEOPLE).map((person) => person.email)].sort(),
		);
		expect(data.members).toHaveLength(persons.length + 1);
		const maya = data.members.find((member) => member.email === PEOPLE.maya.email);
		expect(data.issues.some((issue) => isActiveIssue(issue) && issue.assigneeId === maya?.id)).toBe(
			true,
		);
	});

	it("has the sample's agent as a member, with nothing to act as it with", async () => {
		const { slug, cookie } = await startVisitor(track, "203.0.113.20");
		const data = await read(track, slug, cookie);

		const agents = data.members.filter((member) => member.role === "agent");
		expect(agents).toHaveLength(1);
		const { agent } = agentExample(data);
		expect(agent).toMatchObject({
			name: AGENT.name,
			email: `${agent.id}@agents.invalid`,
			image: null,
			// What an admin set it to propose rather than do.
			proposes: AGENT.proposes,
			removedAt: null,
		});

		// In D1 it is an agent of this sandbox and of no other workspace, and has no key, no
		// password or other account, and no session: an agent acts with a key and nothing else.
		const organizationId = await workspaceId(track, slug);
		const memberships = await track.db
			.prepare('select organization_id, role from "member" where user_id = ?')
			.bind(agent.id)
			.all();
		expect(memberships.results).toEqual([{ organization_id: organizationId, role: "agent" }]);
		for (const table of ["agent_key", "account", "session"]) {
			expect(await count(track, `"${table}" where user_id = '${agent.id}'`), table).toBe(0);
		}
		expect(await count(track, `"agent_key" where organization_id = '${organizationId}'`)).toBe(0);
		// Settings says the same to the visitor, who is the sandbox's admin: one agent, no keys.
		const listed = await track.fetch(
			`${origin}/api/auth/agents/list?organizationId=${organizationId}`,
			{ headers: { origin, cookie } },
		);
		expect(await listed.json()).toEqual([
			expect.objectContaining({ id: agent.id, name: AGENT.name, keys: [] }),
		]);
	});

	it("shows the agent's work on one sample issue: assigned to it, two comments, in review", async () => {
		const { slug, cookie } = await startVisitor(track, "203.0.113.21");
		const data = await read(track, slug, cookie);
		const { agent, issue } = agentExample(data);
		const diego = data.members.find((member) => member.email === PEOPLE.diego.email);
		const design = data.teams.find((team) => team.key === AGENT_EXAMPLE.issue.team);

		expect(issue).toMatchObject({
			teamId: design?.id,
			status: "in_review",
			assigneeId: agent.id,
			creatorId: diego?.id,
			description: AGENT_EXAMPLE.issue.description,
			archivedAt: null,
		});

		const comments = data.comments
			.filter((comment) => comment.issueId === issue.id)
			.sort((a, b) => a.createdAt - b.createdAt);
		expect(comments.map((comment) => comment.authorId)).toEqual([agent.id, agent.id]);
		expect(comments.map((comment) => comment.body)).toEqual(
			[...AGENT_EXAMPLE.start, ...AGENT_EXAMPLE.finish].flatMap((step) =>
				"comment" in step ? [step.comment] : [],
			),
		);

		// Its history names who did what, oldest first: the author assigned it and later put it in
		// a project, and the agent moved it along, each move an entry of its own.
		const polish = data.projects.find((project) => project.name === PROJECTS.polish.name);
		const history = data.activities
			.filter((activity) => activity.issueId === issue.id)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(({ actorId, change, proposedBy }) => ({ actorId, change, proposedBy }));
		expect(history).toEqual([
			{
				actorId: diego?.id,
				change: { type: "assignee", from: null, to: agent.id },
				proposedBy: null,
			},
			{
				actorId: agent.id,
				change: { type: "status", from: "todo", to: "in_progress" },
				proposedBy: null,
			},
			{
				actorId: diego?.id,
				change: { type: "project", from: null, to: polish?.id },
				proposedBy: null,
			},
			{
				actorId: agent.id,
				change: { type: "status", from: "in_progress", to: "in_review" },
				proposedBy: null,
			},
		]);
	});

	it("leaves one open proposal on that issue, the agent's, to move it to Done", async () => {
		const { slug, cookie } = await startVisitor(track, "203.0.113.22");
		const data = await read(track, slug, cookie);
		const { agent, issue, proposals } = agentExample(data);

		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			issueId: issue.id,
			agentId: agent.id,
			change: { type: "status", to: "done" },
		});
		// It is the sandbox's only one, so the sidebar counts one.
		expect(data.proposals).toHaveLength(1);
	});

	it("lets the visitor accept the proposal, which moves the issue to Done as them", async () => {
		const { slug, cookie } = await startVisitor(track, "203.0.113.23");
		const visitor = await session(track, cookie);
		const before = agentExample(await read(track, slug, cookie));
		const proposal = before.proposals[0];
		if (!proposal) throw new Error("No proposal to accept");

		const answer = await mutate(track, slug, cookie, {
			name: "proposal.accept",
			args: { id: proposal.id },
		});
		expect(answer.type).toBe("ack");

		const data = await read(track, slug, cookie);
		const after = agentExample(data);
		expect(after.issue).toMatchObject({ status: "done", assigneeId: before.agent.id });
		expect(data.proposals).toEqual([]);
		// The change is the visitor's, and the history says whose idea it was.
		expect(
			data.activities
				.filter((activity) => activity.issueId === after.issue.id)
				.map(({ actorId, change, proposedBy }) => ({ actorId, change, proposedBy })),
		).toContainEqual({
			actorId: visitor?.user.id,
			change: { type: "status", from: "in_review", to: "done" },
			proposedBy: before.agent.id,
		});
	});

	it("lets the visitor dismiss the proposal, which leaves the issue as it was", async () => {
		const { slug, cookie } = await startVisitor(track, "203.0.113.24");
		const before = await read(track, slug, cookie);
		const proposal = agentExample(before).proposals[0];
		if (!proposal) throw new Error("No proposal to dismiss");

		const answer = await mutate(track, slug, cookie, {
			name: "proposal.dismiss",
			args: { id: proposal.id },
		});
		expect(answer.type).toBe("ack");

		const after = await read(track, slug, cookie);
		expect(after.proposals).toEqual([]);
		// Not a field of the issue changed, and nothing was added to its thread or history.
		const { issue } = agentExample(after);
		expect(issue).toEqual(agentExample(before).issue);
		expect(issue.status).toBe("in_review");
		const about = (data: Snapshot) => ({
			comments: data.comments.filter((comment) => comment.issueId === issue.id),
			activities: data.activities.filter((activity) => activity.issueId === issue.id),
		});
		expect(about(after)).toEqual(about(before));
	});

	it("plans sample issues into Engineering's current cycle, some of them done", async () => {
		const { slug, cookie } = await startVisitor(track, "203.0.113.7");
		const data = (await (await snapshot(track, slug, cookie)).json()) as Snapshot;
		const eng = data.teams.find((team) => team.key === "ENG");
		const today = new Date().toISOString().slice(0, 10);
		const current = data.cycles.find(
			(cycle) => cycle.teamId === eng?.id && cycleState(cycle, today) === "current",
		);
		expect(current).toBeDefined();

		const planned = data.issues.filter((issue) => issue.cycleId === current?.id);
		expect(planned).toHaveLength(ISSUES.filter((issue) => issue.cycle === "current").length);
		expect(planned.length).toBeGreaterThan(3);
		expect(planned.some((issue) => issue.status === "done")).toBe(true);
		expect(planned.some((issue) => issue.status !== "done")).toBe(true);
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

	it("takes no deliveries from GitHub", async () => {
		const visitor = await startVisitor(track, "203.0.113.10");
		const workspace = await track.db
			.prepare("select id from organization where slug = ?")
			.bind(visitor.slug)
			.first<{ id: string }>();
		const delivery = await track.fetch(`${origin}/api/github/${workspace?.id}/any`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": "ping",
				"x-github-delivery": crypto.randomUUID(),
			},
			body: "{}",
		});
		expect(delivery.status).toBe(404);
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
		// Visitors go after a day, with their sandbox. Without a session, these would say 401.
		expect((await attempt("/account/delete", {})).status).toBe(403);
		expect((await attempt("/update-user", { name: "Mallory" })).status).toBe(403);
		expect(
			(await attempt("/change-password", { currentPassword: "a", newPassword: "b" })).status,
		).toBe(403);

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
		// The sample's agent is each sandbox's only one, until the visitor makes another.
		const [oldSample, laggingSample, freshSample] = await Promise.all(
			[oldOrg, laggingOrg, freshOrg].map(async (organizationId) => {
				const ids = await agentIds(track, organizationId);
				expect(ids).toHaveLength(1);
				return ids[0];
			}),
		);
		expect((await track.directory(oldOrg)).members).toContainEqual(
			expect.objectContaining({ id: oldSample, role: "agent", removedAt: null }),
		);
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
		// Nothing is left of the sample's agent either: no user, membership, key, account or session.
		for (const gone of [oldSample, laggingSample]) {
			expect(await count(track, `"user" where id = '${gone}'`)).toBe(0);
			for (const table of ["member", "agent_key", "account", "session"]) {
				expect(await count(track, `"${table}" where user_id = '${gone}'`), table).toBe(0);
			}
		}
		expect(await count(track, `"user" where id = '${freshSample}'`)).toBe(1);
		expect(await agentIds(track, freshOrg)).toEqual(
			expect.arrayContaining([freshSample, freshAgent]),
		);
		// No agent is left without a workspace, whichever sandbox it was made for.
		expect(
			await count(
				track,
				`"user" where email like '%@agents.invalid' and id not in (select user_id from "member")`,
			),
		).toBe(0);
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
		// Make adding the sample members fail partway, after the visitor, the workspace and its
		// sample agent exist.
		await track.db
			.prepare(
				"create trigger refuse_members before insert on member when new.role = 'member' begin select raise(abort, 'refused for the test'); end",
			)
			.run();
		const visitors = await count(track, `"user" where email like '%@visitors.example.com'`);
		const workspaces = await count(track, '"organization"');
		const agents = await count(track, `"user" where email like '%@agents.invalid'`);
		try {
			const { failed, cookie } = await openDemo(track, "203.0.113.61");
			expect(failed).toBe(true);
			expect(await count(track, `"user" where email like '%@visitors.example.com'`)).toBe(visitors);
			expect(await count(track, '"organization"')).toBe(workspaces);
			expect(await count(track, `"user" where email like '%@agents.invalid'`)).toBe(agents);
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
