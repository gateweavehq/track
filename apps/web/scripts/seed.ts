// Fills a local workspace with sample people, teams and issues: `pnpm dev:seed`. It goes through
// the same doors as the app, Better Auth over HTTP and sync mutations through the gateway, so
// the data obeys every server rule and the run doubles as a smoke test. Local development only:
// every account it creates shares one published password.
import { parseArgs } from "node:util";
import type { Snapshot } from "@gateweave/track-protocol";
import {
	HttpError,
	SyncClient,
	type SyncSocket,
	type Transport,
	uuidv7,
} from "@gateweave/track-sync-client";
import { PASSWORD, PEOPLE, type PersonKey, sampleSteps, WORKSPACE_NAME } from "./seed-data";

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
	for (const key of people) {
		const { role, email } = PEOPLE[key];
		if (role === "owner") continue;
		const invitation = await api<{ id: string }>("POST", "/organization/invite-member", owner, {
			email,
			role,
			organizationId: workspace.id,
		});
		await api("POST", "/organization/accept-invitation", sessions[key], {
			invitationId: invitation.id,
		});
	}

	const clients = {} as Record<PersonKey, SyncClient>;
	for (const key of people) {
		const { userId, cookie } = sessions[key];
		clients[key] = new SyncClient({ userId, transport: gatewayTransport(args.slug, cookie) });
	}

	try {
		const steps = sampleSteps({
			userIds: Object.fromEntries(people.map((key) => [key, sessions[key].userId])) as Record<
				PersonKey,
				string
			>,
			newId: uuidv7,
			extraIssues: extra,
		});
		// In order, so teams exist before their issues and the sample issues are numbered as
		// listed. Generated filler only needs to arrive, so it goes in parallel.
		const ordered = steps.filter((step) => !step.parallel);
		for (const { person, mutation } of ordered) await clients[person].mutate(mutation);
		await Promise.all(
			steps
				.filter((step) => step.parallel)
				.map(({ person, mutation }) => clients[person].mutate(mutation)),
		);
		const count = (name: string) => steps.filter((step) => step.mutation.name === name).length;
		console.log(
			`Created ${name} with ${count("team.create")} teams, ${count("label.create")} labels, ${count("project.create")} projects, ${count("issue.create")} issues and ${count("comment.create")} comments.`,
		);
	} finally {
		await Promise.all(people.map((key) => clients[key].close()));
	}
	printAccounts();
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
	for (;;) {
		const response = await fetch(new URL(`/api/auth${path}`, base), {
			method,
			headers: {
				// Better Auth rejects state-changing requests without a trusted Origin.
				Origin: base.origin,
				...(body && { "Content-Type": "application/json" }),
				...(cookie && { Cookie: cookie }),
			},
			body: body && JSON.stringify(body),
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
