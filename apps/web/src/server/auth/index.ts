import { env, waitUntil } from "cloudflare:workers";
import { createDb } from "../db";
import { demoEnabled } from "../demo/mode";
import { mailer } from "../email";
import { forgetInWorkspaces } from "../erasure";
import { allowPasswordTry, allowSpentTriesEmail, authRateLimits } from "../rate-limit";
import {
	deleteWorkspaceFiles,
	destroyWorkspace,
	endSessionsEverywhere,
	findWorkspaceStub,
	placeNewWorkspace,
	reportAudit,
	syncMembership,
	syncUserEverywhere,
} from "../workspaces";
import { createAuth } from "./config";
import { countedByWhoSentIt } from "./workers-address";

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

/** The public demo has no sign-in to offer: the server makes its visitors' accounts. */
const oidc =
	env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && !demoEnabled()
		? {
				issuer: env.OIDC_ISSUER,
				clientId: env.OIDC_CLIENT_ID,
				clientSecret: env.OIDC_CLIENT_SECRET,
				name: env.OIDC_PROVIDER_NAME || "single sign-on",
			}
		: undefined;

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
		// A deployed Worker answers over HTTPS. Local dev has no certificate.
		secureCookies: !baseURL && !import.meta.env.DEV,
		mcpResource,
		github:
			env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
				? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
				: undefined,
		oidc,
		// Membership lives in D1; each workspace's Durable Object keeps a replica for authorization
		// and for showing members to clients. A failed push heals the next time that user connects.
		onMembershipChange: (workspaceId, userId) =>
			logFailure(syncMembership(db, workspaceId, userId), "membership sync"),
		onUserUpdated: (userId) => logFailure(syncUserEverywhere(db, userId), "profile sync"),
		// A socket this misses still closes when its session would have run out.
		onSessionsEnded: (userId, sessionIds) =>
			logFailure(endSessionsEverywhere(db, userId, sessionIds), "closing ended sessions' sockets"),
		// Before anything reaches the new workspace's object, which reaching it makes. One missed is
		// made outside the deployment's jurisdiction, and the daily run moves it.
		onWorkspaceCreated: (workspaceId) =>
			logFailure(placeNewWorkspace(db, workspaceId), "placing a new workspace"),
		onWorkspaceDeleted: async (workspaceId) => {
			// Nobody can reach the files once the membership is gone, so the deletion need not hold
			// up the response, however many there are.
			waitUntil(logFailure(deleteWorkspaceFiles(workspaceId), "deleting a workspace's files"));
			await logFailure(destroyWorkspace(db, workspaceId), "workspace deletion");
		},
		// What this misses stays noted, and the daily cron asks again.
		onAccountDeleted: (userId) =>
			logFailure(forgetInWorkspaces(db, userId), "forgetting a deleted account"),
		onWorkspaceRenamed: (workspaceId, slug) =>
			logFailure(
				findWorkspaceStub(db, workspaceId).then((stub) => stub.relink(slug)),
				"workspace rename",
			),
		// The change is made; an event that does not arrive is lost, and said so in the logs.
		onAudit: (workspaceId, event) => logFailure(reportAudit(db, workspaceId, event), "audit log"),
		demo: demoEnabled(),
		mailer: demoEnabled() ? undefined : mailer,
		runInBackground: waitUntil,
		rateLimitStorage: authRateLimits,
		allowPasswordTry,
		allowSpentTriesEmail,
	});
}

/**
 * Everything from outside reaches Better Auth through here, because its handler counts a request
 * first of all, before anything in it can step in.
 */
export async function handleAuthRequest(request: Request): Promise<Response> {
	return getAuth().handler(await countedByWhoSentIt(request));
}

const PROVIDER_LOGOUT = "/api/auth/backchannel-logout/";

/**
 * Takes a POST for Better Auth. A provider waits only so long for the answer to a logout token, and
 * its giving up would cancel the request, leaving someone signed in to Track after signing out there.
 * So a logout is seen through once it has arrived, and read first, while the sender is still there.
 */
export async function postToAuth(request: Request): Promise<Response> {
	if (!new URL(request.url).pathname.startsWith(PROVIDER_LOGOUT)) {
		return handleAuthRequest(request);
	}
	const arrived = new Request(request.url, {
		method: "POST",
		headers: request.headers,
		body: await request.arrayBuffer(),
	});
	const answer = handleAuthRequest(arrived);
	waitUntil(answer);
	return answer;
}

export const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export const emailEnabled = Boolean(mailer) && !demoEnabled();

/** What the sign-in page calls the OpenID Connect provider, if there is one. */
export const oidcProviderName = oidc?.name ?? null;

async function logFailure(work: Promise<unknown>, what: string) {
	try {
		await work;
	} catch (error) {
		console.error(`auth: ${what} failed`, error);
	}
}
