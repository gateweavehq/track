import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, NO_STORE_HEADERS, sessionMiddleware } from "better-auth/api";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { allowEntry, allowNote, isDomainEntry, MAX_ALLOW_ENTRIES } from "../../lib/sign-up-allow";
import type { Database } from "../db";
import { schema } from "../db";
import { OIDC_PROVIDER } from "./oidc-sign-in";

// "Who runs this server" in docs/architecture.md. The triggers in `0011_sign_up_holds.sql` hold this
// however an account comes to be made. What is here asks first, to answer in words and tell the pages.

export const SIGN_UP_CLOSED = {
	code: "SIGN_UP_CLOSED",
	message: "This server takes new accounts by invitation. Ask whoever runs it to invite you.",
};

export const RUNS_THE_SERVER = {
	code: "RUNS_THE_SERVER",
	message:
		"You run this server, and sign-up is closed, so it would be left with nobody to open it. Open sign-up first, or have someone else take it over.",
};

/** What the page that makes accounts has to tell someone. */
export type SignUpState = "open" | "by-invitation" | "unclaimed";

/** How much of the list is shown at once. The rest is found by searching. */
const LIST_PAGE = 200;

/** Whether this sign-in is the configured OpenID Connect provider's, and not GitHub's or a password. */
export function isProviderSignIn(context: GenericEndpointContext | null): boolean {
	return context?.path === "/callback/:id" && context.params?.id === OIDC_PROVIDER;
}

/**
 * Whether this address may have a new account: the rule of the trigger `user_needs_a_way_in`, with one
 * more way in that a trigger cannot see, an account made through the provider the owner trusts. It
 * says nothing about an address that has one already, so what asks has to look at that itself.
 */
export async function mayMakeAccount(
	db: Database,
	email: string,
	{ throughProvider = false }: { throughProvider?: boolean } = {},
): Promise<boolean> {
	// The plugin reads an address lowercased, so this does too: the Kelvin sign is only a `k` then.
	const address = email.toLowerCase();
	const now = Date.now();
	const row = await db.get<{ allowed: number }>(sql`
		SELECT (
			COALESCE((SELECT sign_up FROM deployment WHERE id = 1), 'closed') = 'open'
			OR NOT EXISTS (SELECT 1 FROM user)
			OR EXISTS (
				SELECT 1 FROM sign_up_allow
				WHERE entry = ${address} OR entry = '@' || substr(${address}, instr(${address}, '@') + 1)
			)
			OR EXISTS (
				SELECT 1 FROM invitation
				WHERE email = ${address} AND status = 'pending' AND expires_at > ${now}
			)
			OR (
				${throughProvider ? 1 : 0} = 1
				AND COALESCE((SELECT trust_provider FROM deployment WHERE id = 1), 0) = 1
			)
		) AS allowed
	`);
	return row?.allowed === 1;
}

export async function signUpState(db: Database): Promise<SignUpState> {
	const row = await db.get<{ signUp: string | null; hasAccounts: number }>(sql`
		SELECT (SELECT sign_up FROM deployment WHERE id = 1) AS signUp,
			EXISTS (SELECT 1 FROM user) AS hasAccounts
	`);
	if (row?.signUp === "open") return "open";
	return row?.hasAccounts === 0 ? "unclaimed" : "by-invitation";
}

export async function ownsDeployment(db: Database, userId: string): Promise<boolean> {
	const { deployment } = schema;
	const row = await db
		.select({ id: deployment.id })
		.from(deployment)
		.where(and(eq(deployment.id, 1), eq(deployment.ownerId, userId)))
		.get();
	return row !== undefined;
}

/** Whether this account has to stay: what the trigger `deployment_keeps_its_owner` holds. */
export async function mustKeepAccount(db: Database, userId: string): Promise<boolean> {
	const { deployment } = schema;
	const row = await db
		.select({ id: deployment.id })
		.from(deployment)
		.where(
			and(eq(deployment.id, 1), eq(deployment.ownerId, userId), eq(deployment.signUp, "closed")),
		)
		.get();
	return row !== undefined;
}

/** To anyone else, the owner's paths do not exist. */
async function requireOwner(db: Database, userId: string) {
	if (!(await ownsDeployment(db, userId))) throw APIError.fromStatus("NOT_FOUND");
}

/**
 * What changes who may make an account wants a sign-in from the last day, because a stolen cookie
 * would otherwise be enough to let anyone in.
 */
function requireFreshSession(
	session: { session: { createdAt: Date | string } },
	ctx: GenericEndpointContext,
) {
	const age = Date.now() - new Date(session.session.createdAt).getTime();
	if (age > ctx.context.sessionConfig.freshAge * 1000) {
		throw APIError.from("FORBIDDEN", {
			code: "SESSION_NOT_FRESH",
			message: "Session is not fresh",
		});
	}
}

function parseBody<Body>(shape: z.ZodType<Body>, raw: unknown): Body {
	const parsed = shape.safeParse(raw);
	if (!parsed.success) {
		throw APIError.from("BAD_REQUEST", {
			code: "INVALID_REQUEST",
			message: parsed.error.issues[0]?.message ?? "That request is not valid.",
		});
	}
	return parsed.data;
}

function noStore(ctx: { setHeader(name: string, value: string): void }) {
	for (const [name, value] of Object.entries(NO_STORE_HEADERS)) ctx.setHeader(name, value);
}

interface DeploymentConfig {
	db: Database;
	/** What the provider's button is called, if one is configured. The trust setting exists only then. */
	providerName: string | undefined;
}

/** What the owner has: who may make an account, and the list that says. */
export function deploymentPlugin({ db, providerName }: DeploymentConfig) {
	const { deployment, signUpAllow } = schema;

	async function change(changes: { signUp?: "open" | "closed"; trustProvider?: boolean }) {
		await db
			.update(deployment)
			.set({ ...changes, updatedAt: new Date() })
			.where(eq(deployment.id, 1))
			.run();
	}

	return {
		id: "deployment",
		endpoints: {
			getDeployment: createAuthEndpoint(
				"/deployment/get",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					await requireOwner(db, ctx.context.session.user.id);
					const query = typeof ctx.query?.q === "string" ? ctx.query.q.trim().toLowerCase() : "";
					const [row, counts, entries] = await Promise.all([
						db
							.select({ signUp: deployment.signUp, trustProvider: deployment.trustProvider })
							.from(deployment)
							.get(),
						db.get<{ total: number; matching: number }>(sql`
							SELECT count(*) AS total,
								coalesce(sum(${query} = '' OR instr(entry, ${query}) > 0
									OR instr(lower(coalesce(note, '')), ${query}) > 0), 0) AS matching
							FROM sign_up_allow
						`),
						db.all<{ entry: string; note: string | null; addedAt: number; hasAccount: number }>(sql`
							SELECT entry, note, added_at AS addedAt, EXISTS (
								SELECT 1 FROM user
								WHERE CASE WHEN substr(sign_up_allow.entry, 1, 1) = '@'
									THEN substr(user.email, instr(user.email, '@')) = sign_up_allow.entry
									ELSE user.email = sign_up_allow.entry END
							) AS hasAccount
							FROM sign_up_allow
							WHERE ${query} = '' OR instr(entry, ${query}) > 0
								OR instr(lower(coalesce(note, '')), ${query}) > 0
							ORDER BY added_at DESC, entry
							LIMIT ${LIST_PAGE}
						`),
					]);
					return {
						signUp: row?.signUp ?? "closed",
						trustProvider: row?.trustProvider ?? false,
						provider: providerName ?? null,
						total: counts?.total ?? 0,
						matching: counts?.matching ?? 0,
						limit: MAX_ALLOW_ENTRIES,
						entries: entries.map(({ hasAccount, ...rest }) => ({
							...rest,
							hasAccount: hasAccount === 1,
						})),
					};
				},
			),
			setDeploymentSignUp: createAuthEndpoint(
				"/deployment/sign-up",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					const { signUp } = parseBody(
						z.strictObject({ signUp: z.enum(["closed", "open"]) }),
						ctx.body,
					);
					requireFreshSession(session, ctx);
					await change({ signUp });
					return { signUp };
				},
			),
			setTrustProvider: createAuthEndpoint(
				"/deployment/trust-provider",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					// Without a provider there is nothing to trust, and no such setting.
					if (!providerName) throw APIError.fromStatus("NOT_FOUND");
					const { trust } = parseBody(z.strictObject({ trust: z.boolean() }), ctx.body);
					requireFreshSession(session, ctx);
					await change({ trustProvider: trust });
					return { trustProvider: trust };
				},
			),
			addToSignUpList: createAuthEndpoint(
				"/deployment/allow/add",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					const body = parseBody(
						z.strictObject({ entry: allowEntry, note: allowNote.optional() }),
						ctx.body,
					);
					requireFreshSession(session, ctx);
					if ((await db.$count(signUpAllow)) >= MAX_ALLOW_ENTRIES) {
						throw APIError.from("BAD_REQUEST", {
							code: "SIGN_UP_LIST_FULL",
							message: `The list holds at most ${MAX_ALLOW_ENTRIES} entries. Remove some first.`,
						});
					}
					const made = await db
						.insert(signUpAllow)
						.values({
							entry: body.entry,
							note: body.note ?? null,
							addedAt: Date.now(),
							addedBy: session.user.id,
						})
						.onConflictDoNothing()
						.returning({ entry: signUpAllow.entry })
						.get();
					if (!made) {
						throw APIError.from("BAD_REQUEST", {
							code: "ALREADY_ON_THE_LIST",
							message: `${body.entry} is on the list already.`,
						});
					}
					return { entry: made.entry, domain: isDomainEntry(made.entry) };
				},
			),
			removeFromSignUpList: createAuthEndpoint(
				"/deployment/allow/remove",
				{ method: "POST", use: [sessionMiddleware] },
				async (ctx) => {
					noStore(ctx);
					const { session } = ctx.context;
					await requireOwner(db, session.user.id);
					const { entry } = parseBody(
						z.strictObject({ entry: z.string().trim().toLowerCase().min(1).max(254) }),
						ctx.body,
					);
					requireFreshSession(session, ctx);
					const gone = await db
						.delete(signUpAllow)
						.where(eq(signUpAllow.entry, entry))
						.returning({ entry: signUpAllow.entry })
						.get();
					if (!gone) {
						throw APIError.from("NOT_FOUND", {
							code: "NOT_ON_THE_LIST",
							message: `${entry} is not on the list.`,
						});
					}
					return { removed: true };
				},
			),
		},
		rateLimit: [{ pathMatcher: (path) => path.startsWith("/deployment/"), window: 60, max: 60 }],
	} satisfies BetterAuthPlugin;
}
