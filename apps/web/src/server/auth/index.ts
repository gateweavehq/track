import { env } from "cloudflare:workers";
import { createDb } from "../db";
import { syncMembership, syncUserEverywhere, workspaceStub } from "../workspaces";
import { createAuth } from "./config";

export const db = createDb(env.DB);

export const auth = createAuth({
	db,
	secret: env.BETTER_AUTH_SECRET,
	baseURL: env.BETTER_AUTH_URL || undefined,
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
});

export const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

async function logFailure(work: Promise<unknown>, what: string) {
	try {
		await work;
	} catch (error) {
		console.error(`auth: ${what} failed`, error);
	}
}
