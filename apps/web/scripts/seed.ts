// Fills a local workspace with sample people, teams and issues: `pnpm dev:seed`. It goes through
// the same doors as the app, Better Auth over HTTP and sync mutations through the gateway, so
// the data obeys every server rule and the run doubles as a smoke test. The one exception: with
// email on, it marks the sample addresses verified in the local database, having no mailbox to
// prove them with. The sample's agent has one door only, MCP with a key, so it and the issue it
// worked on are seeded where that endpoint is on (BETTER_AUTH_URL is set) and left out elsewhere.
// Local development only: every account it creates shares one published password.
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { MutationInput, Snapshot } from "@gateweave/track-protocol";
import {
	HttpError,
	SyncClient,
	type SyncSocket,
	type Transport,
	uuidv7,
} from "@gateweave/track-sync-client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
	AGENT,
	AGENT_KEY,
	currentCycleId,
	PASSWORD,
	PEOPLE,
	type PersonKey,
	sampleSteps,
	WORKSPACE_NAME,
	withCycle,
} from "./seed-data";

const { values: args } = parseArgs({
	options: {
		url: { type: "string", default: "http://localhost:4710" },
		slug: { type: "string", default: "acme" },
		issues: { type: "string", default: "0" },
		help: { type: "boolean", default: false },
	},
});

if (args.help) {
	console.log(`Usage: pnpm dev:seed [--url http://localhost:4710] [--slug acme] [--issues 0]

  --url     where the dev server runs
  --slug    the workspace to create; an existing one is left alone
  --issues  extra generated issues on top of the sample ones, for load testing`);
	process.exit(0);
}

const base = new URL(args.url);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
	fail(`Refusing to seed ${base.origin}: the sample accounts share a public password.`);
}
const extra = Number(args.issues);
if (!Number.isInteger(extra) || extra < 0) fail("--issues must be a whole number");

interface Session {
	userId: string;
	cookie: string;
}

/** The sample's agent while it is being seeded: its member id, its one key and its MCP session. */
interface SeedAgent {
	id: string;
	keyId: string;
	mcp: Client;
}

const people = Object.keys(PEOPLE) as PersonKey[];

// Node's WebSocket (undici) accepts request headers; the DOM typings do not know that.
const NodeWebSocket = WebSocket as unknown as new (
	url: string,
	init: { headers: Record<string, string> },
) => WebSocket;

try {
	await main();
} catch (error) {
	const cause = error instanceof TypeError ? (error.cause as { code?: unknown } | undefined) : null;
	if (cause?.code === "ECONNREFUSED") {
		fail(`Nothing answers at ${base.origin}. Start the app with \`pnpm dev\`, or pass --url.`);
	}
	throw error;
}

async function main() {
	const sessions = {} as Record<PersonKey, Session>;
	for (const key of people) sessions[key] = await signIn(key);
	const owner = sessions.maya;

	const existing = await api<{ id: string; slug: string }[]>("GET", "/organization/list", owner);
	if (existing.some((workspace) => workspace.slug === args.slug)) {
		console.log(`The "${args.slug}" workspace already exists. Pass --slug to seed another one.`);
		printAccounts();
		return;
	}

	const name = args.slug === "acme" ? WORKSPACE_NAME : `${WORKSPACE_NAME} (${args.slug})`;
	const workspace = await api<{ id: string }>("POST", "/organization/create", owner, {
		name,
		slug: args.slug,
	});
	let verified = false;
	for (const key of people) {
		const { role, email } = PEOPLE[key];
		if (role === "owner") continue;
		const invitation = await api<{ id: string }>("POST", "/organization/invite-member", owner, {
			email,
			role,
			organizationId: workspace.id,
		});
		const accept = () =>
			request("POST", "/organization/accept-invitation", sessions[key].cookie, {
				invitationId: invitation.id,
			});
		let response = await accept();
		if (!verified && (await needsVerifiedEmail(response))) {
			verifySampleAddresses();
			verified = true;
			response = await accept();
		}
		if (!response.ok) {
			throw new Error(
				`POST /organization/accept-invitation failed with ${response.status}: ${await response.text()}`,
			);
		}
	}

	const clients = {} as Record<PersonKey, SyncClient>;
	for (const key of people) {
		const { userId, cookie } = sessions[key];
		clients[key] = new SyncClient({ userId, transport: gatewayTransport(args.slug, cookie) });
	}

	const agent = await addAgent(owner, workspace.id);
	try {
		const steps = sampleSteps({
			userIds: Object.fromEntries(people.map((key) => [key, sessions[key].userId])) as Record<
				PersonKey,
				string
			>,
			agentId: agent?.id,
			newId: uuidv7,
			extraIssues: extra,
		});
		// In order, so teams exist before their issues and the sample issues are numbered as
		// listed. Generated filler only needs to arrive, so it goes in parallel.
		const ordered = steps.filter((step) => !step.parallel);
		// Cycle ids are the Durable Object's to make; the owner's replica learns of them as the
		// team update is applied.
		let cycleId: string | undefined;
		for (const step of ordered) {
			if (step.needsCycle) {
				const state = clients.maya.getState();
				cycleId ??= currentCycleId({ teams: state.teams.values(), cycles: state.cycles.values() });
			}
			const { by, mutation } = step.needsCycle && cycleId ? withCycle(step, cycleId) : step;
			if (by !== AGENT_KEY) await clients[by].mutate(mutation);
			else if (agent) await actAsAgent(agent, mutation, clients.maya);
		}
		await Promise.all(
			steps.flatMap(({ by, mutation, parallel }) =>
				parallel && by !== AGENT_KEY ? [clients[by].mutate(mutation)] : [],
			),
		);
		const count = (name: string) => steps.filter((step) => step.mutation.name === name).length;
		console.log(
			`Created ${name} with ${count("team.create")} teams, ${count("label.create")} labels, ${count("project.create")} projects, ${count("issue.create")} issues and ${count("comment.create")} comments.`,
		);
		console.log(
			agent
				? `${AGENT.name}, the sample's agent, worked on one of the issues and left a proposal on it.`
				: `Left out ${AGENT.name}, the sample's agent, and its issue: an agent acts over MCP, which is off here. Set BETTER_AUTH_URL in .dev.vars to seed them too.`,
		);
	} finally {
		await Promise.all(people.map((key) => clients[key].close()));
		if (agent) {
			await agent.mcp.close().catch(() => {});
			// The key was for these steps alone and nothing kept it, so the agent ends with none, as
			// in the demo. Not thrown: it would hide what failed above.
			await api("POST", "/agents/revoke-key", owner, { keyId: agent.keyId }).catch(() =>
				console.error(`Could not revoke ${AGENT.name}'s key. Revoke it in Settings, Agents.`),
			);
		}
	}
	printAccounts();
}

/**
 * Makes the sample's agent as an admin does in Settings, and connects as it over MCP, the one
 * door an agent has. Null where this server has no MCP endpoint, which needs BETTER_AUTH_URL.
 */
async function addAgent(owner: Session, organizationId: string): Promise<SeedAgent | null> {
	const endpoint = new URL("/mcp", base);
	// Without credentials it answers 401 where it is on, and 404 where it is off.
	if ((await fetch(endpoint, { method: "POST" })).status === 404) return null;
	const { agent, key } = await api<{ agent: { id: string; keys: { id: string }[] }; key: string }>(
		"POST",
		"/agents/create",
		owner,
		{ organizationId, name: AGENT.name },
	);
	const keyId = agent.keys[0]?.id;
	if (!keyId) throw new Error("The new agent came back without a key");
	const mcp = new Client({ name: "track-seed", version: "1.0.0" });
	try {
		await mcp.connect(
			new StreamableHTTPClientTransport(endpoint, {
				requestInit: { headers: { Authorization: `Bearer ${key}` } },
			}),
		);
	} catch (error) {
		// The caller revokes the key when it is done, and it never got one to revoke.
		await mcp.close().catch(() => {});
		await api("POST", "/agents/revoke-key", owner, { keyId }).catch(() =>
			console.error(`Could not revoke ${AGENT.name}'s key. Revoke it in Settings, Agents.`),
		);
		throw error;
	}
	return { id: agent.id, keyId, mcp };
}

/**
 * Sends one of the agent's steps as an agent would: a tool call, which names the issue by its
 * key. `replica` is any person's copy of the workspace, to read that key from.
 */
async function actAsAgent(agent: SeedAgent, mutation: MutationInput, replica: SyncClient) {
	const state = replica.getState();
	const on = (issueId: string) => {
		const issue = state.issues.get(issueId);
		const team = issue && state.teams.get(issue.teamId);
		if (!issue || !team) throw new Error(`Issue ${issueId} has not reached the seed's replica`);
		return { workspace: args.slug, key: `${team.key}-${issue.number}` };
	};
	let call: { name: string; arguments: Record<string, unknown> };
	if (mutation.name === "comment.create") {
		call = {
			name: "add_comment",
			arguments: { ...on(mutation.args.issueId), body: mutation.args.body },
		};
	} else if (mutation.name === "issue.update" && mutation.args.patch.status !== undefined) {
		call = {
			name: "update_issue",
			arguments: { ...on(mutation.args.id), status: mutation.args.patch.status },
		};
	} else {
		throw new Error(`The seed cannot send ${mutation.name} as an agent`);
	}
	const result = await agent.mcp.callTool(call);
	if (result.isError) {
		throw new Error(`The agent's ${call.name} failed: ${JSON.stringify(result.content)}`);
	}
}

/** Signs up, or signs in when the account is left over from an earlier run. */
async function signIn(key: PersonKey): Promise<Session> {
	const { name, email } = PEOPLE[key];
	let response = await request("POST", "/sign-up/email", undefined, {
		name,
		email,
		password: PASSWORD,
	});
	if (!response.ok) {
		response = await request("POST", "/sign-in/email", undefined, { email, password: PASSWORD });
	}
	if (!response.ok) {
		fail(
			`Could not sign in as ${email} (${response.status}). Was it created with another password?`,
		);
	}
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((header) => header.split(";")[0])
		.join("; ");
	return { userId: user.id, cookie };
}

/**
 * With email on, Better Auth lets only people who proved their address accept an invitation, and
 * proving it takes the mailbox, which the sample addresses do not have.
 */
async function needsVerifiedEmail(response: Response): Promise<boolean> {
	if (response.status !== 403) return false;
	const body = (await response
		.clone()
		.json()
		.catch(() => null)) as { code?: unknown } | null;
	return (
		typeof body?.code === "string" && body.code.startsWith("EMAIL_VERIFICATION_REQUIRED_BEFORE")
	);
}

/**
 * Marks the sample people's addresses as proven, in the local database the dev server uses (the
 * one `pnpm dev:setup` migrates). The only write that skips the app's doors, and only to the
 * published sample accounts on this machine.
 */
function verifySampleAddresses() {
	const emails = people.map((key) => `'${PEOPLE[key].email}'`).join(", ");
	// Where vite.config.ts keeps the dev server's state.
	const state = process.env.TRACK_STATE_DIR ?? ".wrangler/state";
	console.log("Email is on, so the sample people's addresses are marked as verified first.");
	try {
		execSync(
			`pnpm exec wrangler d1 execute DB --local --persist-to "${state}" --command "UPDATE user SET email_verified = 1 WHERE email IN (${emails})"`,
			{ stdio: "ignore" },
		);
	} catch {
		fail(
			"Could not mark the sample addresses as verified in the local database. Run `pnpm dev:setup`, or comment out EMAIL_FROM in .dev.vars and restart `pnpm dev`.",
		);
	}
}

async function api<T = unknown>(
	method: "GET" | "POST",
	path: string,
	session: Session,
	body?: object,
): Promise<T> {
	const response = await request(method, path, session.cookie, body);
	if (!response.ok) {
		throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
	}
	return (await response.json()) as T;
}

async function request(method: string, path: string, cookie?: string, body?: object) {
	const send = () =>
		fetch(new URL(`/api/auth${path}`, base), {
			method,
			headers: {
				// Better Auth rejects state-changing requests without a trusted Origin.
				Origin: base.origin,
				...(body && { "Content-Type": "application/json" }),
				...(cookie && { Cookie: cookie }),
			},
			body: body && JSON.stringify(body),
		});
	for (;;) {
		// The dev server drops connections left idle for a few seconds, as one is while Wrangler
		// marks the sample addresses verified, and Node can still pick that one for the next request.
		const response = await send().catch((error: unknown) => {
			const cause = error instanceof TypeError ? (error.cause as { code?: unknown }) : null;
			if (cause?.code === "ECONNRESET") return send();
			throw error;
		});
		// Sign-ups are rate limited per client, a few every 10 seconds, and this signs up several.
		if (response.status !== 429) return response;
		const seconds = Number(response.headers.get("x-retry-after")) || 1;
		await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
	}
}

/**
 * The browser transport relies on the page's cookies and origin. Node has neither, so this one
 * sends them explicitly. The gateway checks the Origin of every socket.
 */
function gatewayTransport(slug: string, cookie: string): Transport {
	const url = new URL(`/api/sync/${encodeURIComponent(slug)}`, base);
	const headers = { Cookie: cookie, Origin: base.origin };

	async function get(method: "GET" | "HEAD") {
		const response = await fetch(`${url}/snapshot`, { method, headers });
		if (!response.ok) throw new HttpError(response.status);
		return response;
	}

	return {
		snapshot: async () => (await (await get("GET")).json()) as Snapshot,
		probe: async () => {
			await get("HEAD");
		},
		connect(handlers): SyncSocket {
			const ws = new NodeWebSocket(`${url.href.replace(/^http/, "ws")}/socket`, { headers });
			ws.onopen = () => handlers.open();
			ws.onmessage = (event) => {
				if (typeof event.data === "string") handlers.message(event.data);
			};
			ws.onclose = (event) => handlers.close(event.code, event.reason);
			return {
				send: (data) => ws.send(data),
				close: (code, reason) => ws.close(code, reason),
			};
		},
	};
}

function printAccounts() {
	console.log(
		`\nOpen ${new URL(`/${args.slug}`, base)} and sign in as any of (password: ${PASSWORD}):`,
	);
	for (const key of people) {
		const { email, role } = PEOPLE[key];
		console.log(`  ${email.padEnd(20)} ${role}`);
	}
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}
