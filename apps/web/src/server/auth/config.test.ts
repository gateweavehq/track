import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database, schema } from "../db";
import { createAuth } from "./config";

// Deleting an account takes its memberships with it by cascade, so no organization hook runs.
// The app does not offer account deletion over HTTP, so this drives Better Auth's own deletion,
// which every path to it shares, against a real D1 database (TRK-66).

let mf: Miniflare;
let db: Database;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "auth-config-test" },
		}),
	);
	const d1 = await mf.getD1Database("DB");
	const migrations = resolve(import.meta.dirname, "../../../migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
	// Miniflare's D1 type is its own; it is the same binding a Worker gets.
	db = createDb(d1 as unknown as D1Database);
});

afterAll(async () => {
	await mf?.dispose();
});

describe("Better Auth's hooks", () => {
	it("tells each of a deleted user's workspaces, once their membership is gone", async () => {
		const now = new Date();
		await db.insert(schema.user).values({ id: "u-dana", name: "Dana", email: "dana@example.com" });
		for (const id of ["w-acme", "w-initech"]) {
			await db.insert(schema.organization).values({ id, name: id, slug: id, createdAt: now });
			await db.insert(schema.member).values({
				id: `m-${id}`,
				organizationId: id,
				userId: "u-dana",
				role: "member",
				createdAt: now,
			});
		}
		const told: { workspaceId: string; userId: string; stillMember: boolean }[] = [];
		const auth = createAuth({
			db,
			secret: "a-test-secret-that-is-long-enough-for-better-auth",
			baseURL: "http://localhost:4710",
			onMembershipChange: async (workspaceId, userId) => {
				const row = await db
					.select()
					.from(schema.member)
					.where(eq(schema.member.organizationId, workspaceId))
					.get();
				told.push({ workspaceId, userId, stillMember: row !== undefined });
			},
		});

		await (await auth.$context).internalAdapter.deleteUser("u-dana");

		expect(told.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
			{ workspaceId: "w-acme", userId: "u-dana", stillMember: false },
			{ workspaceId: "w-initech", userId: "u-dana", stillMember: false },
		]);
	});

	it("tells a user's workspaces nothing while deleting them fails, and only once it succeeds", async () => {
		const now = new Date();
		await db.insert(schema.user).values({ id: "u-erin", name: "Erin", email: "erin@example.com" });
		await db.insert(schema.organization).values({
			id: "w-hooli",
			name: "Hooli",
			slug: "hooli",
			createdAt: now,
		});
		await db.insert(schema.member).values({
			id: "m-erin",
			organizationId: "w-hooli",
			userId: "u-erin",
			role: "member",
			createdAt: now,
		});
		const d1 = await mf.getD1Database("DB");
		await d1
			.prepare(
				`CREATE TRIGGER keep_erin BEFORE DELETE ON "user" WHEN OLD.id = 'u-erin'
				BEGIN SELECT RAISE(ABORT, 'Erin stays'); END`,
			)
			.run();
		const told: string[] = [];
		const auth = createAuth({
			db,
			secret: "a-test-secret-that-is-long-enough-for-better-auth",
			baseURL: "http://localhost:4710",
			onMembershipChange: async (workspaceId) => {
				told.push(workspaceId);
			},
		});
		try {
			await expect((await auth.$context).internalAdapter.deleteUser("u-erin")).rejects.toThrow();
		} finally {
			await d1.prepare("DROP TRIGGER keep_erin").run();
		}
		expect(told).toEqual([]);
		expect(await db.select().from(schema.member).where(eq(schema.member.userId, "u-erin"))).toEqual(
			[expect.objectContaining({ organizationId: "w-hooli" })],
		);

		// She joins another workspace before the delete is tried again. The one that goes through
		// tells the workspaces she belongs to then, each once, and nothing from the failed try.
		await db.insert(schema.organization).values({
			id: "w-pied",
			name: "Pied Piper",
			slug: "pied",
			createdAt: now,
		});
		await db.insert(schema.member).values({
			id: "m-erin-pied",
			organizationId: "w-pied",
			userId: "u-erin",
			role: "member",
			createdAt: now,
		});
		await (await auth.$context).internalAdapter.deleteUser("u-erin");
		expect(told.sort()).toEqual(["w-hooli", "w-pied"]);
	});
});

/**
 * Every route answering over HTTP, with every feature on, since some only exist with one. An upgrade
 * of Better Auth or a plugin can add a route, and nothing else would notice it being served. A route
 * failing this needs a decision: close it in `disabledPaths`, give it a limit of its own in
 * `customRules`, or add it here because it is fine as it is.
 */
const SERVED = [
	// Signing up, in and out, and what follows from them.
	"GET /error",
	"GET /ok",
	"GET /reset-password/:token",
	"GET /verify-email",
	"GET,POST /callback/:id",
	"GET,POST /get-session",
	"POST /backchannel-logout/:id",
	"POST /request-password-reset",
	"POST /reset-password",
	"POST /send-verification-email",
	"POST /sign-in/email",
	"POST /sign-in/social",
	"POST /sign-out",
	"POST /sign-up/email",

	// Someone's own account and sessions.
	"POST /account/delete",
	"POST /change-password",
	"POST /revoke-other-sessions",
	"POST /revoke-session",
	"POST /revoke-sessions",
	"POST /update-session",
	"POST /update-user",

	// Off unless configured, and they are not: `user.changeEmail` and `user.deleteUser`.
	"GET /delete-user/callback",
	"POST /change-email",
	"POST /delete-user",

	// Workspaces. Each checks membership and role for itself.
	"GET /organization/get-active-member",
	"GET /organization/get-active-member-role",
	"GET /organization/get-invitation",
	"GET /organization/get-organization",
	"GET /organization/list",
	"GET /organization/list-invitations",
	"GET /organization/list-members",
	"GET /organization/list-user-invitations",
	"POST /organization/accept-invitation",
	"POST /organization/cancel-invitation",
	"POST /organization/check-slug",
	"POST /organization/create",
	"POST /organization/delete",
	"POST /organization/has-permission",
	"POST /organization/invite-member",
	"POST /organization/leave",
	"POST /organization/reject-invitation",
	"POST /organization/remove-member",
	"POST /organization/set-active",
	"POST /organization/update",
	"POST /organization/update-member-role",

	// Agent members.
	"GET /agents/list",
	"POST /agents/create",
	"POST /agents/create-key",
	"POST /agents/delete",
	"POST /agents/revoke-key",
	"POST /agents/update",

	// The OAuth flow that MCP clients sign in through.
	"GET /.well-known/oauth-authorization-server",
	"GET /.well-known/openid-configuration",
	"GET /jwks",
	"GET /oauth2/public-client",
	"GET,POST /oauth2/authorize",
	"GET,POST /oauth2/end-session",
	"GET,POST /oauth2/userinfo",
	"POST /oauth2/consent",
	"POST /oauth2/continue",
	"POST /oauth2/end-session/confirm",
	"POST /oauth2/introspect",
	"POST /oauth2/public-client-prelogin",
	"POST /oauth2/register",
	"POST /oauth2/revoke",
	"POST /oauth2/token",
];

/** Marked server-only, and answered over HTTP all the same. They say nothing that isn't public. */
const SERVER_ONLY_BUT_ANSWERED = new Set([
	"/.well-known/oauth-authorization-server",
	"/.well-known/openid-configuration",
]);

describe("What Better Auth serves", () => {
	const everyFeature = () =>
		createAuth({
			db,
			secret: "a-test-secret-that-is-long-enough-for-better-auth",
			baseURL: "https://track.test",
			github: { clientId: "id", clientSecret: "secret" },
			oidc: { issuer: "https://id.test", clientId: "id", clientSecret: "secret" },
			mcpResource: "https://track.test/mcp",
			mailer: { send: async () => {} },
		});

	/** The routes with a path, as the router sees them. One without is only ever called in-process. */
	function routes(auth: ReturnType<typeof everyFeature>) {
		return Object.values(auth.api).flatMap((value) => {
			const endpoint = value as unknown as {
				path?: string;
				options: { method: string | string[]; metadata?: { SERVER_ONLY?: boolean } };
			};
			if (!endpoint.path) return [];
			const { method, metadata } = endpoint.options;
			const open = !metadata?.SERVER_ONLY || SERVER_ONLY_BUT_ANSWERED.has(endpoint.path);
			return [{ path: endpoint.path, methods: [method].flat(), open }];
		});
	}

	it("answers on the routes listed here, and no others", () => {
		const auth = everyFeature();
		const closed = new Set<string>(auth.options.disabledPaths);
		const served = routes(auth)
			.filter(({ path, open }) => open && !closed.has(path))
			.map(({ path, methods }) => `${methods.join(",")} ${path}`);

		expect(
			{
				added: served.filter((route) => !SERVED.includes(route)),
				gone: SERVED.filter((route) => !served.includes(route)),
			},
			"A route Better Auth serves has changed. See the comment on SERVED for what to decide.",
		).toEqual({ added: [], gone: [] });
	});

	it("answers 404 on every route closed to HTTP", async () => {
		const auth = everyFeature();
		const closed = new Set<string>(auth.options.disabledPaths);
		const unreachable = routes(auth).filter(({ path, open }) => !open || closed.has(path));
		// A closed path no route has any more would be a sign of a renamed one, still open.
		expect(unreachable.map(({ path }) => path)).toEqual(expect.arrayContaining([...closed]));

		for (const { path, methods } of unreachable) {
			for (const method of methods) {
				const address = `https://track.test/api/auth${path.replaceAll(/:\w+/g, "x")}`;
				const response = await auth.handler(
					new Request(address, {
						method,
						headers: { origin: "https://track.test", "content-type": "application/json" },
						...(method === "GET" ? {} : { body: "{}" }),
					}),
				);
				expect(response.status, `${method} ${path}`).toBe(404);
			}
		}
	});
});
