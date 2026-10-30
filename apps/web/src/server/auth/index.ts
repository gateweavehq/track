import { env, waitUntil } from "cloudflare:workers";
import { createDb } from "../db";
import { demoEnabled } from "../demo/mode";
import { mailer } from "../email";
import { authRateLimits } from "../rate-limit";
import {
	deleteWorkspaceFiles,
	syncMembership,
	syncUserEverywhere,
	workspaceStub,
} from "../workspaces";
import { createAuth } from "./config";

export const db = createDb(env.DB);

const baseURL = env.BETTER_AUTH_URL || undefined;

/**
 * The MCP endpoint's canonical URL. Agents' tokens are bound to it, so it exists only when the
 * base URL is pinned rather than inferred from each request.
 */
export const mcpResource = baseURL ? new URL("/mcp", baseURL).href : undefined;

/** The app's origin: the pinned base URL's, or else the request's. */
export function appOrigin(request: Request): string {
	return new URL(baseURL ?? request.url).origin;
}

let instance: ReturnType<typeof buildAuth> | undefined;

/**
 * The isolate's one Better Auth instance, built on first use. Better Auth starts resolving its
 * context as soon as it is created, and the oauth-provider plugin queries D1 while doing so
 * (it seeds `oauth_resource`). workerd forbids I/O in global scope, so building at module load
 * logs an error on every cold start.
 */
export function getAuth() {
	instance ??= buildAuth();
	return instance;
}

function buildAuth() {
	return createAuth({
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
		onWorkspaceDeleted: async (workspaceId) => {
			// Nobody can reach the files once the membership is gone, so the deletion need not hold
			// up the response, however many there are.
			waitUntil(logFailure(deleteWorkspaceFiles(workspaceId), "deleting a workspace's files"));
			await logFailure(workspaceStub(workspaceId).destroy(), "workspace deletion");
		},
		onWorkspaceRenamed: (workspaceId, slug) =>
			logFailure(workspaceStub(workspaceId).relink(slug), "workspace rename"),
		demo: demoEnabled(),
		mailer: demoEnabled() ? undefined : mailer,
		runInBackground: waitUntil,
		rateLimitStorage: authRateLimits,
	});
}

export const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export const emailEnabled = Boolean(mailer) && !demoEnabled();

async function logFailure(work: Promise<unknown>, what: string) {
	try {
		await work;
	} catch (error) {
		console.error(`auth: ${what} failed`, error);
	}
}
