import { env, waitUntil } from "cloudflare:workers";
import { createDb } from "../db";
import { mailer } from "../email";
import { syncMembership, syncUserEverywhere, workspaceStub } from "../workspaces";
import { createAuth } from "./config";

export const db = createDb(env.DB);

const baseURL = env.BETTER_AUTH_URL || undefined;

/**
 * The MCP endpoint's canonical URL. Agents' tokens are bound to it, so it exists only when the
 * base URL is pinned rather than inferred from each request.
 */
export const mcpResource = baseURL ? new URL("/mcp", baseURL).href : undefined;

export const auth = createAuth({
	db,
	secret: env.BETTER_AUTH_SECRET,
	baseURL,
	mcpResource,
	github:
		env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
			? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
			: undefined,
	// Membership lives in D1; each workspace's Durable Object keeps a replica for authorization
	// and for showing members to clients. A failed push heals the next time that user connects.
	onMembershipChange: (workspaceId, userId) =>
		logFailure(syncMembership(db, workspaceId, userId), "membership sync"),
	onUserUpdated: (userId) => logFailure(syncUserEverywhere(db, userId), "profile sync"),
	onWorkspaceDeleted: (workspaceId) =>
		logFailure(workspaceStub(workspaceId).destroy(), "workspace deletion"),
	mailer,
	runInBackground: waitUntil,
});

export const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export const emailEnabled = Boolean(mailer);

async function logFailure(work: Promise<unknown>, what: string) {
	try {
		await work;
	} catch (error) {
		console.error(`auth: ${what} failed`, error);
	}
}
