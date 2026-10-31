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
