import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
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

/** Workspace slugs are URL segments, so they must not collide with app routes. */
function assertSlug(slug: string) {
	const problem = slugProblem(slug);
	if (problem) throw new APIError("BAD_REQUEST", { message: problem });
}
