import type { Snapshot } from "@gateweave/track-protocol";
import type { Directory, SourceEventResult, WorkspaceDO } from "@gateweave/track-sync-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Agent members (TRK-25): an admin makes an agent, and the agent works in that one workspace
// over MCP with its key, as itself, through the same mutations as people.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

/** Calls Better Auth as Track's own pages do, each test from its own client address. */
function authApi(path: string, init: { client: string; cookie?: string; body?: object }) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method: init.body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			...(init.body && { "content-type": "application/json" }),
			...(init.cookie && { cookie: init.cookie }),
		},
		body: init.body && JSON.stringify(init.body),
	});
}

async function ok<T>(response: Promise<Response>): Promise<T> {
	const settled = await response;
	if (!settled.ok) throw new Error(`${settled.status} ${await settled.text()}`);
	return (await settled.json()) as T;
}

interface Person {
	id: string;
	name: string;
	email: string;
	cookie: string;
}

async function signUp(client: string, name: string, email: string): Promise<Person> {
	const response = await authApi("/sign-up/email", {
		client,
		body: { name, email, password: "a-long-test-password" },
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, name, email, cookie };
}

/** A workspace with an Engineering team, owned by `owner`. */
async function workspace(client: string, owner: Person, name: string, slug: string) {
	const { id } = await ok<{ id: string }>(
		authApi("/organization/create", { client, cookie: owner.cookie, body: { name, slug } }),
	);
	const team = await track.mutate(
		id,
		{ id: owner.id, name: owner.name, email: owner.email, image: null, role: "owner" },
		{ name: "team.create", args: { id: crypto.randomUUID(), key: "ENG", name: "Engineering" } },
	);
	expect(team.ok).toBe(true);
	return id;
}

interface AgentInfo {
	id: string;
	name: string;
	keys: { id: string; start: string; lastUsedAt: number | null }[];
}

function createAgent(client: string, admin: Person, organizationId: string, name: string) {
	return ok<{ agent: AgentInfo; key: string }>(
		authApi("/agents/create", { client, cookie: admin.cookie, body: { organizationId, name } }),
	);
}

async function connect(key: string) {
	const client = new Client({ name: "triage", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
			fetch: track.fetch,
			requestInit: { headers: { authorization: `Bearer ${key}` } },
		}),
	);
	return client;
}

/** What /mcp answers to an MCP client starting a session with this key. */
async function mcpStatus(key: string) {
	const response = await track.fetch(`${origin}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${key}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "triage", version: "1.0.0" },
			},
		}),
	});
	return response.status;
}

async function userExists(id: string) {
	return (await track.db.prepare("SELECT id FROM user WHERE id = ?").bind(id).first()) !== null;
}

async function memberIdOf(userId: string) {
	const row = await track.db
		.prepare("SELECT id FROM member WHERE user_id = ?")
		.bind(userId)
		.first<{ id: string }>();
	if (!row) throw new Error(`${userId} is not a member anywhere`);
	return row.id;
}

/** Makes someone a member without the invitation flow, which other tests cover. */
async function addMember(organizationId: string, userId: string, role: string) {
	await track.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), organizationId, userId, role, Date.now())
		.run();
}

it("binds one replayable work run to the administrator's issue and repository", async () => {
	const client = "203.0.113.99";
	const owner = await signUp(client, "Run owner", "run-owner@example.com");
	const slug = "scoped-runs";
	const acme = await workspace(client, owner, "Scoped runs", slug);
	const { agent, key } = await createAgent(client, owner, acme, "Local runner");
	const other = await createAgent(client, owner, acme, "Other runner");
	const abroad = await workspace(client, owner, "Other workspace", "other-workspace");
	const outside = await createAgent(client, owner, abroad, "External runner");
	const profile = { ...owner, role: "owner" as const, image: null };
	const { teams } = await track.rpc<Directory>(acme, "directory");
	const teamId = teams[0]?.id;
	if (!teamId) throw new Error("Missing team");
	const mutate = (input: Parameters<typeof track.mutate>[2]) => track.mutate(acme, profile, input);
	expect(
		(
			await mutate({
				name: "issue.create",
				args: {
					id: "assigned",
					teamId,
					title: "An assigned issue",
					assigneeId: agent.id,
					sortOrder: "a0",
				},
			})
		).ok,
	).toBe(true);
	expect(
		(
			await mutate({
				name: "issue.create",
				args: {
					id: "other-issue",
					teamId,
					title: "Another issue",
					assigneeId: agent.id,
					sortOrder: "a1",
				},
			})
		).ok,
	).toBe(true);
	const made = await track.rpc<ReturnType<WorkspaceDO["manageSource"]>>(
		acme,
		"manageSource",
		owner.id,
		{
			kind: "create",
			input: {
				name: "Agents",
				product: "agents",
				teamId,
				lowestSeverity: "high",
				closeWhenCleared: false,
				linkOrigins: ["https://builds.example.test"],
			},
		},
	);
	if (!made.ok) throw new Error(made.message);

	const post = (action: string, body: object, extra: Record<string, string>) =>
		track.fetch(`${origin}/api/work-runs/${action}`, {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": client, ...extra },
			body: JSON.stringify(body),
		});
	const runner = (action: string, body: object, bearer = key) =>
		post(action, body, { authorization: `Bearer ${bearer}` });
	const register = (body: object, browserOrigin = origin) =>
		post("register", body, { cookie: owner.cookie, origin: browserOrigin });
	const registration = {
		workspace: slug,
		issue: "ENG-1",
		sourceId: made.value.id,
		repository: "acme/site",
	};
	expect((await register(registration, "https://elsewhere.test")).status).toBe(403);
	expect((await runner("register", registration)).status).toBe(403);
	expect((await runner("find", { issue: "ENG-1" })).status).toBe(404);
	const registered = await register(registration);
	expect(registered.status).toBe(201);
	const { requestId } = await ok<{ requestId: string }>(Promise.resolve(registered));
	expect(await ok(register(registration))).toMatchObject({ requestId });
	expect((await register({ ...registration, repository: "acme/other" })).status).toBe(409);
	expect(await ok(runner("find", { issue: "ENG-1" }))).toMatchObject({
		requestId,
		repository: "acme/site",
		activeAttemptId: null,
		lastAttemptState: null,
	});
	expect((await runner("find", { issue: "ENG-2" })).status).toBe(404);

	const claim = { requestId, claimId: crypto.randomUUID() };
	expect((await runner("claim", claim, other.key)).status).toBe(404);
	expect((await runner("claim", claim, outside.key)).status).toBe(404);
	const firstReplies = await Promise.all([runner("claim", claim), runner("claim", claim)]);
	expect(firstReplies.map((reply) => reply.status).sort()).toEqual([200, 201]);
	interface Grant {
		attemptId: string;
		attemptNo: number;
		repository: string;
		token: string;
		active: boolean;
	}
	const grant = await ok<Grant>(Promise.resolve(firstReplies[0] as Response));
	expect(await ok(Promise.resolve(firstReplies[1] as Response))).toEqual(grant);
	// Another spelling of the same nonce is the same claim, and recovers the same token.
	expect(await ok(runner("claim", { ...claim, claimId: claim.claimId.toUpperCase() }))).toEqual(
		grant,
	);
	expect(grant).toMatchObject({ attemptNo: 1, repository: "acme/site", active: true });
	expect(grant.token).toMatch(/^gwh_[\w-]{43}$/);
	expect((await runner("claim", { ...claim, claimId: crypto.randomUUID() })).status).toBe(409);

	const report = { attemptId: grant.attemptId, token: grant.token, state: "running", sequence: 1 };
	expect((await runner("report", report, other.key)).status).toBe(404);
	expect((await runner("report", report, outside.key)).status).toBe(404);
	expect((await runner("report", { ...report, token: `gwh_${"x".repeat(43)}` })).status).toBe(404);
	expect((await runner("report", { ...report, issue: "ENG-2" })).status).toBe(400);
	expect((await runner("report", { ...report, repository: "acme/other" })).status).toBe(400);
	expect((await runner("report", { ...report, url: "https://elsewhere.test/build" })).status).toBe(
		400,
	);
	const bypass = await track.rpc<SourceEventResult>(
		acme,
		"sourceEvent",
		made.value.id,
		"test-key",
		JSON.stringify({
			kind: "run",
			key: grant.attemptId,
			state: "passed",
			issue: "ENG-2",
			title: "Other issue",
			sentAt: new Date().toISOString(),
		}),
		`${origin}/${slug}`,
	);
	expect(bypass.status).toBe(400);
	expect(await ok(runner("report", { ...report, url: "https://builds.example.test/run" }))).toEqual(
		{
			state: "running",
			sequence: 1,
			applied: true,
		},
	);
	const terminal = { ...report, state: "passed", sequence: 3 };
	expect(await ok(runner("report", terminal))).toEqual({
		state: "passed",
		sequence: 3,
		applied: true,
	});
	expect(await ok(runner("report", terminal))).toEqual({
		state: "passed",
		sequence: 3,
		applied: false,
	});
	expect(await ok(runner("report", { ...report, sequence: 2 }))).toEqual({
		state: "passed",
		sequence: 3,
		applied: false,
	});
	expect((await runner("report", { ...report, sequence: 4 })).status).toBe(409);
	expect((await runner("claim", { ...claim, claimId: crypto.randomUUID() })).status).toBe(409);
	const retryClaim = { ...claim, claimId: crypto.randomUUID(), previousAttemptId: grant.attemptId };
	expect(await ok(runner("find", { issue: "ENG-1" }))).toMatchObject({
		activeAttemptId: null,
		lastAttemptId: grant.attemptId,
		lastAttemptState: "passed",
	});
	const retry = await ok<Grant>(runner("claim", retryClaim));
	expect(retry).toMatchObject({ attemptNo: 2, repository: "acme/site", active: true });
	expect(retry.token).not.toBe(grant.token);
	expect((await runner("report", { ...report, attemptId: retry.attemptId })).status).toBe(404);
	const snapshot = await track.rpc<Snapshot>(acme, "snapshot", profile);
	expect(snapshot.signals).toHaveLength(2);
	expect(snapshot.signals).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: grant.attemptId,
				issueId: "assigned",
				state: "passed",
				executor: "local-runner",
				url: "https://builds.example.test/run",
				// WEB-86: the Runs card names an attempt by this number, not by its id.
				attemptNo: 1,
				// WEB-84: the Runs page filters by the registration's repository.
				repository: "acme/site",
			}),
			expect.objectContaining({
				id: retry.attemptId,
				issueId: "assigned",
				state: "queued",
				attemptNo: 2,
				repository: "acme/site",
			}),
		]),
	);
	expect(JSON.stringify(snapshot.signals)).not.toContain(grant.token);

	const assigned = snapshot.issues.find(({ id }) => id === "assigned");
	if (!assigned || !("version" in assigned)) throw new Error("Missing live issue");
	expect(
		(
			await mutate({
				name: "issue.update",
				args: {
					id: "assigned",
					baseVersion: assigned.version,
					patch: { assigneeId: other.agent.id },
				},
			})
		).ok,
	).toBe(true);
	const reassigned = await ok<{ requestId: string }>(register(registration));
	expect(reassigned.requestId).not.toBe(requestId);
	const next = { requestId: reassigned.requestId, claimId: crypto.randomUUID() };
	expect((await runner("claim", next, other.key)).status).toBe(409);
	expect(await ok(runner("claim", retryClaim))).toMatchObject({
		attemptId: retry.attemptId,
		token: retry.token,
		active: true,
		canLaunch: false,
	});
	expect(
		(
			await runner("report", {
				attemptId: retry.attemptId,
				token: retry.token,
				sequence: 1,
				state: "cancelled",
			})
		).status,
	).toBe(200);
	const nextGrant = await ok<Grant>(runner("claim", next, other.key));
	const reconcile = { workspace: slug, attemptId: nextGrant.attemptId, state: "cancelled" };
	expect((await runner("reconcile", reconcile, other.key)).status).toBe(403);
	expect((await post("reconcile", reconcile, { cookie: owner.cookie, origin })).status).toBe(200);
	// WEB-86: an attempt that has ended keeps its outcome, and says so; an unknown one is not found.
	const again = await post(
		"reconcile",
		{ ...reconcile, state: "passed" },
		{ cookie: owner.cookie, origin },
	);
	expect(again.status).toBe(409);
	expect(await again.json()).toMatchObject({ error: "This attempt has already ended" });
	expect(
		(
			await post(
				"reconcile",
				{ ...reconcile, attemptId: crypto.randomUUID() },
				{ cookie: owner.cookie, origin },
			)
		).status,
	).toBe(404);
	expect(await ok(runner("find", { issue: "ENG-1" }, other.key))).toMatchObject({
		activeAttemptId: null,
		lastAttemptId: nextGrant.attemptId,
		lastAttemptState: "cancelled",
	});
	expect(
		(
			await runner(
				"report",
				{
					attemptId: nextGrant.attemptId,
					token: nextGrant.token,
					state: "running",
					sequence: 1,
				},
				other.key,
			)
		).status,
	).toBe(409);
});

it("WEB-84: admits a claim only from the executor the registration names", async () => {
	const client = "203.0.113.98";
	const owner = await signUp(client, "Cloud owner", "cloud-owner@example.com");
	const slug = "cloud-runs";
	const acme = await workspace(client, owner, "Cloud runs", slug);
	const { agent, key } = await createAgent(client, owner, acme, "Pilot launcher");
	const profile = { ...owner, role: "owner" as const, image: null };
	const { teams } = await track.rpc<Directory>(acme, "directory");
	const teamId = teams[0]?.id;
	if (!teamId) throw new Error("Missing team");
	for (const [id, title, sortOrder] of [
		["cloud-issue", "Runs in the cloud", "a0"],
		["local-issue", "Runs here", "a1"],
	] as const) {
		const made = await track.mutate(acme, profile, {
			name: "issue.create",
			args: { id, teamId, title, assigneeId: agent.id, sortOrder },
		});
		expect(made.ok).toBe(true);
	}
	const source = await track.rpc<ReturnType<WorkspaceDO["manageSource"]>>(
		acme,
		"manageSource",
		owner.id,
		{
			kind: "create",
			input: {
				name: "Agents",
				product: "agents",
				teamId,
				lowestSeverity: "high",
				closeWhenCleared: false,
				linkOrigins: [],
			},
		},
	);
	if (!source.ok) throw new Error(source.message);
	const post = (action: string, body: object, extra: Record<string, string>) =>
		track.fetch(`${origin}/api/work-runs/${action}`, {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": client, ...extra },
			body: JSON.stringify(body),
		});
	const runner = (action: string, body: object) =>
		post(action, body, { authorization: `Bearer ${key}` });
	const register = (body: object) => post("register", body, { cookie: owner.cookie, origin });
	const base = { workspace: slug, sourceId: source.value.id, repository: "acme/site" };

	const cloud = { ...base, issue: "ENG-1", executor: "cloud" };
	const { requestId } = await ok<{ requestId: string }>(register(cloud));
	expect(await ok(register(cloud))).toMatchObject({ requestId, executor: "cloud" });
	expect((await register({ ...cloud, executor: "local-runner" })).status).toBe(409);
	expect((await register({ ...cloud, executor: "agents-hosted" })).status).toBe(400);
	expect(await ok(runner("find", { issue: "ENG-1" }))).toMatchObject({ executor: "cloud" });

	// The local runner names no executor, so it claims as itself and is refused.
	const local = await runner("claim", { requestId, claimId: crypto.randomUUID() });
	expect(local.status).toBe(409);
	expect(await local.json()).toEqual({ error: "This work is registered for a cloud run" });
	const granted = await ok<{ attemptId: string; attemptNo: number }>(
		runner("claim", { requestId, claimId: crypto.randomUUID(), executor: "cloud" }),
	);
	expect(granted.attemptNo).toBe(1);

	// Registration without an executor stays with the local runner, as before.
	const here = await ok<{ requestId: string; executor: string }>(
		register({ ...base, issue: "ENG-2" }),
	);
	expect(here.executor).toBe("local-runner");
	const refused = await runner("claim", {
		requestId: here.requestId,
		claimId: crypto.randomUUID(),
		executor: "cloud",
	});
	expect(refused.status).toBe(409);
	expect(await refused.json()).toEqual({ error: "This work is registered for the local runner" });
	const ran = await ok<{ attemptId: string }>(
		runner("claim", { requestId: here.requestId, claimId: crypto.randomUUID() }),
	);

	const snapshot = await track.rpc<Snapshot>(acme, "snapshot", profile);
	expect(snapshot.signals).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: granted.attemptId, issueId: "cloud-issue", executor: "cloud" }),
			expect.objectContaining({
				id: ran.attemptId,
				issueId: "local-issue",
				executor: "local-runner",
			}),
		]),
	);
});

it("WEB-87: an admin reads the current assignment's approval from Track's own pages", async () => {
	const client = "203.0.113.97";
	const owner = await signUp(client, "Approval owner", "approval-owner@example.com");
	const member = await signUp(client, "Approval member", "approval-member@example.com");
	const slug = "runner-approvals";
	const acme = await workspace(client, owner, "Runner approvals", slug);
	await addMember(acme, member.id, "member");
	const { agent, key } = await createAgent(client, owner, acme, "Approved runner");
	const profile = { ...owner, role: "owner" as const, image: null };
	const { teams } = await track.rpc<Directory>(acme, "directory");
	const teamId = teams[0]?.id;
	if (!teamId) throw new Error("Missing team");
	const made = await track.mutate(acme, profile, {
		name: "issue.create",
		args: { id: "approve-me", teamId, title: "Approve me", assigneeId: agent.id, sortOrder: "a0" },
	});
	expect(made.ok).toBe(true);
	const source = await track.rpc<ReturnType<WorkspaceDO["manageSource"]>>(
		acme,
		"manageSource",
		owner.id,
		{
			kind: "create",
			input: {
				name: "Agents",
				product: "agents",
				teamId,
				lowestSeverity: "high",
				closeWhenCleared: false,
				linkOrigins: [],
			},
		},
	);
	if (!source.ok) throw new Error(source.message);
	const post = (action: string, body: object, extra: Record<string, string>) =>
		track.fetch(`${origin}/api/work-runs/${action}`, {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": client, ...extra },
			body: JSON.stringify(body),
		});
	const asOwner = { cookie: owner.cookie, origin };
	const lookup = { workspace: slug, issue: "ENG-1" };

	// Before an approval there is none, and only an admin from Track's own pages may ask.
	expect((await post("approval", lookup, asOwner)).status).toBe(404);
	expect(
		(await post("approval", lookup, { cookie: owner.cookie, origin: "https://elsewhere.test" }))
			.status,
	).toBe(403);
	expect((await post("approval", lookup, { cookie: member.cookie, origin })).status).toBe(403);
	// A runner's key is no session, even from Track's origin.
	expect((await post("approval", lookup, { authorization: `Bearer ${key}`, origin })).status).toBe(
		401,
	);
	expect((await post("approval", { ...lookup, issue: "eng-1" }, asOwner)).status).toBe(400);

	const registration = {
		...lookup,
		sourceId: source.value.id,
		repository: "acme/site",
		executor: "cloud",
	};
	const { requestId } = await ok<{ requestId: string }>(post("register", registration, asOwner));
	expect(await ok(post("approval", lookup, asOwner))).toEqual({
		requestId,
		repository: "acme/site",
		executor: "cloud",
		sourceId: source.value.id,
		activeAttemptId: null,
		lastAttemptId: null,
		lastAttemptState: null,
	});
	const { attemptId } = await ok<{ attemptId: string }>(
		post(
			"claim",
			{ requestId, claimId: crypto.randomUUID(), executor: "cloud" },
			{ authorization: `Bearer ${key}` },
		),
	);
	expect(await ok(post("approval", lookup, asOwner))).toMatchObject({
		activeAttemptId: attemptId,
		lastAttemptId: attemptId,
		lastAttemptState: "queued",
	});

	// Another assignment starts unapproved.
	const issue = (await track.rpc<Snapshot>(acme, "snapshot", profile)).issues.find(
		({ id }) => id === "approve-me",
	);
	if (!issue || !("version" in issue)) throw new Error("Missing live issue");
	const reassigned = await track.mutate(acme, profile, {
		name: "issue.update",
		args: { id: "approve-me", baseVersion: issue.version, patch: { assigneeId: null } },
	});
	expect(reassigned.ok).toBe(true);
	expect((await post("approval", lookup, asOwner)).status).toBe(404);
});

describe("agent members, in the Workers runtime", () => {
	it("lets an admin make an agent that works in its workspace over MCP, as itself", async () => {
		const client = "203.0.113.10";
		const maya = await signUp(client, "Maya Chen", "maya@example.com");
		const acme = await workspace(client, maya, "Acme", "acme");

		const created = await createAgent(client, maya, acme, "Triage");
		expect(created.key).toMatch(/^gwt_[A-Za-z0-9_-]{43}$/);
		expect(created.agent).toMatchObject({
			name: "Triage",
			keys: [{ start: created.key.slice(0, 12), lastUsedAt: null }],
		});

		const mcp = await connect(created.key);
		const workspaces = await mcp.callTool({ name: "list_workspaces", arguments: {} });
		const directory = await mcp.callTool({
			name: "get_workspace",
			arguments: { workspace: "acme" },
		});
		const issue = await mcp.callTool({
			name: "create_issue",
			arguments: { workspace: "acme", team: "ENG", title: "Login fails on Safari" },
		});
		const team = await mcp.callTool({
			name: "create_team",
			arguments: { workspace: "acme", name: "Operations" },
		});
		await mcp.close();

		expect(workspaces.structuredContent).toEqual({
			workspaces: [{ slug: "acme", name: "Acme", role: "agent" }],
		});
		// An agent learns which member it is, so it can tell the issues assigned to it.
		expect(directory.structuredContent).toMatchObject({
			you: { id: created.agent.id, name: "Triage", role: "agent" },
		});
		// The issue is the agent's own, and the agent can do what members do, nothing more.
		expect(issue.structuredContent).toMatchObject({
			key: "ENG-1",
			creator: `${created.agent.id}@agents.invalid`,
		});
		expect(team.isError).toBe(true);
		const { members } = await track.directory(acme);
		expect(members).toContainEqual(
			expect.objectContaining({ id: created.agent.id, name: "Triage", role: "agent" }),
		);
		const [listed] = await ok<AgentInfo[]>(
			authApi(`/agents/list?organizationId=${acme}`, { client, cookie: maya.cookie }),
		);
		expect(listed?.keys[0]?.lastUsedAt).toEqual(expect.any(Number));
		expect(track.outbound).toEqual([]);
	});

	it("keeps an agent to the workspace its key was made for", async () => {
		const client = "203.0.113.11";
		const ana = await signUp(client, "Ana Silva", "ana@example.com");
		const initech = await workspace(client, ana, "Initech", "initech");
		const globex = await workspace(client, ana, "Globex", "globex");
		const { agent, key } = await createAgent(client, ana, initech, "Triage");
		// Even should it come to belong to another workspace, its key does not reach that one.
		await addMember(globex, agent.id, "agent");

		const mcp = await connect(key);
		const workspaces = await mcp.callTool({ name: "list_workspaces", arguments: {} });
		const other = await mcp.callTool({
			name: "get_workspace",
			arguments: { workspace: "globex" },
		});
		await mcp.close();

		expect(workspaces.structuredContent).toEqual({
			workspaces: [{ slug: "initech", name: "Initech", role: "agent" }],
		});
		expect(other.isError).toBe(true);
	});

	it("stops a key once revoked, and every key once its agent is deleted", async () => {
		const client = "203.0.113.12";
		const kai = await signUp(client, "Kai Novak", "kai@example.com");
		const hooli = await workspace(client, kai, "Hooli", "hooli");
		const { agent, key: first } = await createAgent(client, kai, hooli, "Triage");
		const { secret: second } = await ok<{ secret: string }>(
			authApi("/agents/create-key", { client, cookie: kai.cookie, body: { agentId: agent.id } }),
		);
		const firstKey = agent.keys[0];
		if (!firstKey) throw new Error("A new agent comes with a key");

		await ok(
			authApi("/agents/revoke-key", { client, cookie: kai.cookie, body: { keyId: firstKey.id } }),
		);
		expect(await mcpStatus(first)).toBe(401);
		expect(await mcpStatus(second)).toBe(200);

		await ok(
			authApi("/agents/delete", { client, cookie: kai.cookie, body: { agentId: agent.id } }),
		);
		expect(await mcpStatus(second)).toBe(401);
		expect(await userExists(agent.id)).toBe(false);
		// The workspace keeps its name for what it did, as for a person who left.
		const { members } = await track.directory(hooli);
		expect(members).toContainEqual(
			expect.objectContaining({ id: agent.id, name: "Triage", removedAt: expect.any(Number) }),
		);
	});

	it("lets only admins manage agents", async () => {
		const client = "203.0.113.13";
		const owner = await signUp(client, "Olivia Owner", "olivia@example.com");
		const lena = await signUp(client, "Lena Fischer", "lena@example.com");
		const umbrella = await workspace(client, owner, "Umbrella", "umbrella");
		await addMember(umbrella, lena.id, "member");
		const { agent } = await createAgent(client, owner, umbrella, "Triage");
		const key = agent.keys[0];
		if (!key) throw new Error("A new agent comes with a key");

		const asMember = (path: string, body?: object) =>
			authApi(path, { client, cookie: lena.cookie, ...(body && { body }) });
		const refused = await Promise.all([
			asMember("/agents/create", { organizationId: umbrella, name: "Mine" }),
			asMember(`/agents/list?organizationId=${umbrella}`),
			asMember("/agents/create-key", { agentId: agent.id }),
			asMember("/agents/revoke-key", { keyId: key.id }),
			asMember("/agents/update", { agentId: agent.id, name: "Renamed" }),
			asMember("/agents/delete", { agentId: agent.id }),
		]);
		expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
	});

	it("keeps agents' addresses and roles out of everyone's reach", async () => {
		const client = "203.0.113.14";
		const sam = await signUp(client, "Sam Okafor", "sam@example.com");
		const stark = await workspace(client, sam, "Stark", "stark");
		const { agent } = await createAgent(client, sam, stark, "Triage");
		const email = `${agent.id}@agents.invalid`;
		const memberId = await memberIdOf(agent.id);

		const signUpAs = await authApi("/sign-up/email", {
			client,
			body: { name: "Not an agent", email: "me@agents.invalid", password: "a-long-test-password" },
		});
		const signInAs = await authApi("/sign-in/email", {
			client,
			body: { email, password: "a-long-test-password" },
		});
		const invite = await authApi("/organization/invite-member", {
			client,
			cookie: sam.cookie,
			body: { email: "new@agents.invalid", role: "member", organizationId: stark },
		});
		// An agent made admin would let its key manage the workspace.
		const promote = await authApi("/organization/update-member-role", {
			client,
			cookie: sam.cookie,
			body: { memberId, role: "admin", organizationId: stark },
		});
		const remove = await authApi("/organization/remove-member", {
			client,
			cookie: sam.cookie,
			body: { memberIdOrEmail: email, organizationId: stark },
		});

		expect([signUpAs.status, signInAs.status, invite.status]).toEqual([400, 400, 400]);
		expect([promote.status, remove.status]).toEqual([403, 403]);
		const role = await track.db
			.prepare("SELECT role FROM member WHERE id = ?")
			.bind(memberId)
			.first<{ role: string }>();
		expect(role?.role).toBe("agent");
	});

	it("deletes a workspace's agents with the workspace", async () => {
		const client = "203.0.113.15";
		const max = await signUp(client, "Max Weber", "max@example.com");
		const wayne = await workspace(client, max, "Wayne", "wayne");
		const { agent, key } = await createAgent(client, max, wayne, "Triage");

		await ok(
			authApi("/organization/delete", {
				client,
				cookie: max.cookie,
				body: { organizationId: wayne },
			}),
		);

		expect(await userExists(agent.id)).toBe(false);
		expect(await userExists(max.id)).toBe(true);
		expect(await mcpStatus(key)).toBe(401);
	});
});
