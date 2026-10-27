import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, eq } from "drizzle-orm";
import { slugProblem } from "../../lib/slug";
import type { Database } from "../db";
import { schema } from "../db";

export interface AuthConfig {
	db: Database;
	secret: string;
	baseURL?: string | undefined;
	github?: { clientId: string; clientSecret: string } | undefined;
	/** Called after any change to who belongs to a workspace, or with which role. */
	onMembershipChange?: (workspaceId: string, userId: string) => Promise<void>;
	/** Called after a workspace is deleted. */
	onWorkspaceDeleted?: (workspaceId: string) => Promise<void>;
	/** Called after a user's profile changes. */
	onUserUpdated?: (userId: string) => Promise<void>;
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

	return betterAuth({
		secret: config.secret,
		baseURL: config.baseURL,
		database: drizzleAdapter(config.db, { provider: "sqlite", schema }),
		telemetry: { enabled: false },
		emailAndPassword: { enabled: true },
		socialProviders: config.github ? { github: config.github } : {},
		// Returns every pending invitation to any member, ids included (see the hook below). The
		// app does not use it.
		disabledPaths: ["/organization/get-full-organization"],
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
				// Links are shared by hand until Tangent sends email, so give people time.
				invitationExpiresIn: INVITATION_LIFETIME_SECONDS,
				// Accounts do not verify their email yet, so requiring it would block every
				// invitation. The list-invitations hook above keeps ids away from members instead.
				// Turn this on together with email verification.
				requireEmailVerificationOnInvitation: false,
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
			// Must stay last: forwards Set-Cookie headers from server-side auth calls.
			tanstackStartCookies(),
		],
	});
}

export type Auth = ReturnType<typeof createAuth>;

export const INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/** Owners and admins can invite, matching Better Auth's default access control. */
function canInvite(role: string) {
	return role.split(",").some((r) => r.trim() === "owner" || r.trim() === "admin");
}

/** Workspace slugs are URL segments, so they must not collide with app routes. */
function assertSlug(slug: string) {
	const problem = slugProblem(slug);
	if (problem) throw new APIError("BAD_REQUEST", { message: problem });
}
