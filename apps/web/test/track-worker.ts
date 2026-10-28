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
 */
export async function startTrack(origin: string) {
	const config = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8")) as BuiltConfig;
	const outbound: string[] = [];
	// Miniflare 5 still takes its documented v4 options through this converter.
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: "track",
					modules: builtModules(),
					modulesRoot: serverDir,
					compatibilityDate: config.compatibility_date,
					compatibilityFlags: config.compatibility_flags,
					bindings: {
						BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
						BETTER_AUTH_URL: origin,
						EMAIL_FROM: `${EMAIL_FROM.name} <${EMAIL_FROM.email}>`,
					},
					serviceBindings: { EMAIL: "outbox" },
					d1Databases: { DB: "track-test" },
					durableObjects: { WORKSPACE: { className: "WorkspaceDO", useSQLite: true } },
					outboundService: (request) => {
						outbound.push(request.url);
						return new Response("Outbound requests are blocked in this test", { status: 502 });
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

	return {
		/** A `fetch` that reaches the Worker directly. Redirects are returned, not followed. */
		async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
			const request = new Request(input, init);
			const response = await mf.dispatchFetch(request.url, {
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
		},
		/** URLs the Worker tried to fetch from outside. */
		outbound,
		/** Every email sent so far, oldest first. Email goes out after the response. */
		async emails(): Promise<SentEmail[]> {
			const response = await mf.dispatchFetch("http://outbox.test/");
			return (await response.json()) as SentEmail[];
		},
		/** The D1 database, for setting up state the app has no endpoint for. */
		db,
		dispose: () => mf.dispose(),
	};
}
