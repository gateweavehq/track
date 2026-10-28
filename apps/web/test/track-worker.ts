import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare, type V4ModuleDefinition } from "miniflare";

const app = resolve(import.meta.dirname, "..");
const serverDir = join(app, "dist/server");

interface BuiltConfig {
	compatibility_date: string;
	compatibility_flags?: string[];
}

/** One line the Worker wrote to its console. */
export interface WorkerLog {
	level: string;
	message: string;
}

/** What Track handed to its email binding. */
export interface SentEmail {
	from: string | { name: string; email: string };
	to: string;
	subject: string;
	text: string;
	html: string;
}

/** The address Track sends from in tests. */
export const EMAIL_FROM = { name: "Gateweave Track", email: "track@track.test" };

// Stands in for Cloudflare Email Service behind the EMAIL binding: `send` keeps each message,
// and a fetch lists them.
const OUTBOX = `
import { WorkerEntrypoint } from "cloudflare:workers";
const sent = [];
export default class Outbox extends WorkerEntrypoint {
	async send(message) {
		sent.push(message);
		return { messageId: crypto.randomUUID() };
	}
	async fetch() {
		return Response.json(sent);
	}
}
`;

// Reads a workspace's Durable Object over RPC, as the app's own Worker would, so tests can see
// what is stored in it (or that it has been emptied). GET /<workspaceId> returns its directory.
// POST /<workspaceId> applies {member, mutation} as that member, as a gateway would.
const INSPECTOR = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Inspector extends WorkerEntrypoint {
	async fetch(request) {
		const id = new URL(request.url).pathname.slice(1);
		if (request.method === "POST") {
			const { member, mutation } = await request.json();
			const stub = this.env.WORKSPACE.getByName(id);
			return Response.json(await stub.mutate(member, "test", crypto.randomUUID(), mutation));
		}
		try {
			return Response.json(await this.env.WORKSPACE.getByName(id).directory());
		} catch (error) {
			// A destroyed workspace has lost its tables.
			return Response.json({ teams: [], labels: [], members: [], error: String(error) });
		}
	}
}
`;

/** Every module of the built Worker. Its migrations are imported as text. */
function builtModules(): V4ModuleDefinition[] {
	const modules: V4ModuleDefinition[] = [];
	for (const file of readdirSync(serverDir, { recursive: true, encoding: "utf8" })) {
		const path = join(serverDir, file);
		if (file.endsWith(".js")) modules.push({ type: "ESModule", path });
		else if (file.endsWith(".sql")) modules.push({ type: "Text", path });
	}
	return modules;
}

/**
 * The built Worker in workerd, as deployed: D1 migrated, one Durable Object per workspace, and
 * served at `origin` without a network. Requests go in through `fetch`.
 *
 * Every outbound request fails, the way a deployed Worker's request to its own hostname does.
 * Track needs no outside service for sign-in or MCP, so code that only works because local dev
 * can reach itself fails here instead of in production. Email is on, and lands in `emails()`.
 *
 * With `isolates` above 1, more copies of the Worker share the database and Durable Objects but
 * nothing in memory, as isolates in production do. `fetchIn` reaches a given one.
 */
export async function startTrack(
	origin: string,
	{ isolates = 1, demo = false }: { isolates?: number; demo?: boolean } = {},
) {
	const config = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8")) as BuiltConfig;
	const outbound: string[] = [];
	const logs: WorkerLog[] = [];
	const modules = builtModules();
	const secret = randomBytes(32).toString("base64url");
	const names = Array.from({ length: isolates }, (_, i) => (i === 0 ? "track" : `track-${i + 1}`));
	// Miniflare 5 still takes its documented v4 options through this converter.
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			// Keep what the Worker logs for `logs`, and still show it as Miniflare would.
			handleStructuredLogs: (log) => {
				logs.push(log);
				console.error(`[worker ${log.level}] ${log.message}`);
			},
			workers: [
				...names.map((name, index) => ({
					name,
					// Requests go to the first copy unless their host is another copy's route.
					routes: index === 0 ? [] : [`${name}.test/*`],
					modules,
					modulesRoot: serverDir,
					compatibilityDate: config.compatibility_date,
					compatibilityFlags: config.compatibility_flags,
					bindings: {
						BETTER_AUTH_SECRET: secret,
						BETTER_AUTH_URL: origin,
						// The demo deployment has no email binding and no sender.
						...(demo
							? { TRACK_DEMO: "1" }
							: { EMAIL_FROM: `${EMAIL_FROM.name} <${EMAIL_FROM.email}>` }),
					},
					...(!demo && { serviceBindings: { EMAIL: "outbox" } }),
					d1Databases: { DB: "track-test" },
					// Every copy uses the first one's Durable Objects.
					durableObjects: {
						WORKSPACE: { className: "WorkspaceDO", useSQLite: true, scriptName: names[0] },
						RATE_LIMITER: { className: "RateLimiter", useSQLite: true, scriptName: names[0] },
					},
					outboundService: (request: Request) => {
						outbound.push(request.url);
						return new Response("Outbound requests are blocked in this test", { status: 502 });
					},
				})),
				{
					name: "inspector",
					modules: true,
					script: INSPECTOR,
					routes: ["inspector.test/*"],
					compatibilityDate: config.compatibility_date,
					durableObjects: {
						WORKSPACE: { className: "WorkspaceDO", useSQLite: true, scriptName: names[0] },
					},
				},
				{
					name: "outbox",
					modules: true,
					script: OUTBOX,
					routes: ["outbox.test/*"],
					compatibilityDate: config.compatibility_date,
				},
			],
		}),
	);

	const db = await mf.getD1Database("DB");
	const migrations = join(app, "migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await db.batch(statements.map((statement) => db.prepare(statement)));
	}

	/** A `fetch` that reaches one copy of the Worker directly. Redirects are returned. */
	async function fetchIn(
		isolate: number,
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		const name = names[isolate];
		if (!name) throw new Error(`There are only ${names.length} isolates`);
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (isolate > 0) url.host = `${name}.test`;
		const response = await mf.dispatchFetch(url, {
			method: request.method,
			headers: [...request.headers],
			body: request.body ? await request.arrayBuffer() : undefined,
			redirect: "manual",
		});
		const headers = new Headers();
		for (const [name, value] of response.headers) {
			if (name !== "set-cookie") headers.append(name, value);
		}
		for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
		const empty = response.status === 204 || response.status === 304;
		return new Response(empty ? null : await response.arrayBuffer(), {
			status: response.status,
			headers,
		});
	}

	return {
		/** A `fetch` that reaches the Worker directly. Redirects are returned, not followed. */
		fetch: (input: string | URL | Request, init?: RequestInit) => fetchIn(0, input, init),
		fetchIn,
		/** URLs the Worker tried to fetch from outside. */
		outbound,
		/** Everything the Worker has logged so far, oldest first. */
		logs,
		/** Every email sent so far, oldest first. Email goes out after the response. */
		async emails(): Promise<SentEmail[]> {
			const response = await mf.dispatchFetch("http://outbox.test/");
			return (await response.json()) as SentEmail[];
		},
		/** Runs the Worker's Cron Trigger once, as Cloudflare would. */
		async runScheduled() {
			// Miniflare's Fetcher type leaves out the scheduled() workerd adds to every Worker stub.
			const worker = (await mf.getWorker(names[0])) as unknown as {
				scheduled(event: { cron: string; scheduledTime: Date }): Promise<unknown>;
			};
			await worker.scheduled({ cron: "*/30 * * * *", scheduledTime: new Date() });
		},
		/** A workspace's teams and members as its Durable Object holds them now. */
		async directory(workspaceId: string): Promise<{ teams: unknown[]; members: unknown[] }> {
			const response = await mf.dispatchFetch(`http://inspector.test/${workspaceId}`);
			return (await response.json()) as { teams: unknown[]; members: unknown[] };
		},
		/**
		 * Applies a mutation in a workspace's Durable Object as `member`, the way the gateways do
		 * after checking membership, for state a test needs before the part it is about.
		 */
		async mutate(
			workspaceId: string,
			member: { id: string; name: string; email: string; image: string | null; role: string },
			mutation: { name: string; args: object },
		): Promise<{ ok: boolean }> {
			const response = await mf.dispatchFetch(`http://inspector.test/${workspaceId}`, {
				method: "POST",
				body: JSON.stringify({ member, mutation }),
			});
			return (await response.json()) as { ok: boolean };
		},
		/** The D1 database, for setting up state the app has no endpoint for. */
		db,
		dispose: () => mf.dispose(),
	};
}
