import { mcp } from "@better-auth/mcp";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { jwt, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, count, eq, gt } from "drizzle-orm";
import { slugProblem } from "../../lib/slug";
import type { Database } from "../db";
import { schema } from "../db";
import type { Mailer } from "../email/mailer";
import { invitationEmail, passwordResetEmail } from "../email/templates";

export interface AuthConfig {
	db: Database;
	secret: string;
	baseURL?: string | undefined;
	github?: { clientId: string; clientSecret: string } | undefined;
	/**
	 * URL of the MCP endpoint. Turns Track into an OAuth server that AI agents sign in to, with
	 * tokens bound to this URL. It must be canonical, so it needs a pinned `baseURL`.
	 */
	mcpResource?: string | undefined;
	/** Called after any change to who belongs to a workspace, or with which role. */
	onMembershipChange?: (workspaceId: string, userId: string) => Promise<void>;
	/** Called after a workspace is deleted. */
	onWorkspaceDeleted?: (workspaceId: string) => Promise<void>;
	/** Called after a user's profile changes. */
	onUserUpdated?: (userId: string) => Promise<void>;
	/** Sends email. Without it, password reset is off and invitations are links to share. */
	mailer?: Mailer | undefined;
	/** Keeps work such as sending email going after the response, like `ctx.waitUntil`. */
	runInBackground?: ((work: Promise<unknown>) => void) | undefined;
}

/**
 * Builds the Better Auth instance. Kept free of `cloudflare:workers` imports so the Better Auth
 * CLI can load it to generate the database schema.
 *
 * Workspaces are Better Auth organizations: the plugin owns members, roles and invitations.
 */
export function createAuth(config: AuthConfig) {
	const membershipChanged = async (workspaceId: string, userId: string) =>
		config.onMembershipChange?.(workspaceId, userId);
	const { mailer } = config;

	return betterAuth({
		secret: config.secret,
		baseURL: config.baseURL,
		database: drizzleAdapter(config.db, { provider: "sqlite", schema }),
		telemetry: { enabled: false },
		// Better Auth only turns its limiter on by itself when NODE_ENV is "production", which a
		// Worker never sets. Its defaults allow 3 sign-ins per 10 seconds per client. It stays on
		// in local dev too, so what works there works deployed.
		rateLimit: {
			enabled: true,
			// Each invitation can send an email, so admins get fewer than the default 100 per 10s.
			customRules: { "/organization/invite-member": { window: 60, max: 20 } },
		},
		advanced: {
			ipAddress: {
				// Cloudflare sets this to the address it saw. Clients can add to X-Forwarded-For,
				// and Better Auth puts every request whose address it cannot trust in one bucket.
				ipAddressHeaders: ["cf-connecting-ip"],
			},
			// Email goes out after the response. For password reset this also keeps the response
			// time the same whether or not the account exists.
			...(config.runInBackground && {
				backgroundTasks: { handler: config.runInBackground },
			}),
		},
		emailAndPassword: {
			enabled: true,
			...(mailer && {
				sendResetPassword: async ({ user, url }) => {
					await mailer.send({ to: user.email, ...passwordResetEmail({ url }) });
				},
				// A reset is how someone takes an account back, so it ends every other session.
				revokeSessionsOnPasswordReset: true,
			}),
		},
		socialProviders: config.github ? { github: config.github } : {},
		disabledPaths: [
			// Returns every pending invitation to any member, ids included (see the hook below).
			// The app does not use it.
			"/organization/get-full-organization",
			// The JWT plugin's session-to-token exchange. Agents get tokens through OAuth instead.
			"/token",
		],
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== "/organization/list-invitations") return;
				// Better Auth lets every member list invitations. Until accounts verify their
				// email, an invitation's id is enough to accept it with a new account under the
				// invited address, so only those who can invite may see the ids.
				const session = await getSessionFromCtx(ctx);
				const organizationId: unknown =
					ctx.query?.organizationId ?? session?.session.activeOrganizationId;
				if (!session || typeof organizationId !== "string") return;
				const membership = await config.db
					.select({ role: schema.member.role })
					.from(schema.member)
					.where(
						and(
							eq(schema.member.organizationId, organizationId),
							eq(schema.member.userId, session.user.id),
						),
					)
					.get();
				if (membership && !canInvite(membership.role)) {
					throw new APIError("FORBIDDEN", { message: "Only admins can see invitations" });
				}
			}),
		},
		databaseHooks: {
			user: {
				update: {
					after: async (user) => {
						await config.onUserUpdated?.(user.id);
					},
				},
			},
		},
		plugins: [
			organization({
				// Links are shared by hand until Track sends email, so give people time.
				invitationExpiresIn: INVITATION_LIFETIME_SECONDS,
				// Accounts do not verify their email yet, so requiring it would block every
				// invitation. The list-invitations hook above keeps ids away from members instead.
				// Turn this on together with email verification.
				requireEmailVerificationOnInvitation: false,
				...(mailer && {
					sendInvitationEmail: async (
						{ id, email, organization, inviter, invitation },
						request,
					) => {
						// Invitations carry text the inviter chose to any address, from our domain. Only
						// people who proved they own their address send them, and only so many a day;
						// everyone else shares the link by hand, as before.
						if (!inviter.user.emailVerified) return;
						const since = new Date(Date.now() - DAY_MS);
						const sent = await config.db
							.select({ n: count() })
							.from(schema.invitation)
							.where(
								and(
									eq(schema.invitation.inviterId, inviter.user.id),
									gt(schema.invitation.createdAt, since),
								),
							)
							.get();
						if ((sent?.n ?? 0) > INVITATION_EMAILS_PER_DAY) {
							console.warn("auth: invitation email skipped, daily limit reached");
							return;
						}
						const origin = appOrigin(config.baseURL, request);
						if (!origin) return;
						await mailer.send({
							to: email,
							...invitationEmail({
								inviter: { name: inviter.user.name, email: inviter.user.email },
								workspace: organization.name,
								url: new URL(`/invite/${encodeURIComponent(id)}`, origin).href,
								expiresAt: new Date(invitation.expiresAt).getTime(),
							}),
						});
					},
				}),
				organizationHooks: {
					beforeCreateOrganization: async ({ organization }) => {
						assertSlug(organization.slug ?? "");
					},
					beforeUpdateOrganization: async ({ organization }) => {
						if (organization.slug) assertSlug(organization.slug);
					},
					afterCreateOrganization: ({ organization, member }) =>
						membershipChanged(organization.id, member.userId),
					afterAddMember: ({ organization, member }) =>
						membershipChanged(organization.id, member.userId),
					afterAcceptInvitation: ({ organization, member }) =>
						membershipChanged(organization.id, member.userId),
					afterUpdateMemberRole: ({ organization, member }) =>
						membershipChanged(organization.id, member.userId),
					afterRemoveMember: ({ organization, member }) =>
						membershipChanged(organization.id, member.userId),
					afterDeleteOrganization: async ({ organization }) => {
						await config.onWorkspaceDeleted?.(organization.id);
					},
				},
			}),
			...(config.mcpResource
				? [
						// Signs access tokens; the MCP endpoint verifies them against its JWKS. Sessions
						// are not turned into JWTs: tokens come only from the OAuth flow.
						jwt({ disableSettingJwtHeader: true }),
						mcp({
							resource: config.mcpResource,
							loginPage: "/login",
							consentPage: "/oauth/consent",
							scopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE],
							// MCP clients register themselves. Anyone can register a client, so the
							// consent page names where the grant will go, and consent is never skipped.
							allowDynamicClientRegistration: true,
							allowUnauthenticatedClientRegistration: true,
							// Some clients leave out application_type; infer it from the redirect URIs.
							clientRegistrationDefaultApplicationType: "infer",
						}),
					]
				: []),
			// Must stay last: forwards Set-Cookie headers from server-side auth calls.
			tanstackStartCookies(),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;

export const INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/** How many invitations one person can send by email in a day. More still work as links. */
export const INVITATION_EMAILS_PER_DAY = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lets an agent act as the user in Track: read and change what the user can. */
export const MCP_SCOPE = "track";

/** Owners and admins can invite, matching Better Auth's default access control. */
function canInvite(role: string) {
	return role.split(",").some((r) => r.trim() === "owner" || r.trim() === "admin");
}

/** Where links in email point: the pinned base URL, or the host the request came to. */
function appOrigin(baseURL: string | undefined, request: Request | undefined) {
	if (baseURL) return new URL(baseURL).origin;
	return request ? new URL(request.url).origin : undefined;
}

/** Workspace slugs are URL segments, so they must not collide with app routes. */
function assertSlug(slug: string) {
	const problem = slugProblem(slug);
	if (problem) throw new APIError("BAD_REQUEST", { message: problem });
}
