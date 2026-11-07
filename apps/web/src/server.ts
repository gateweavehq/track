import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { isAutomated } from "./lib/intake-email";
import { db, handleAuthRequest } from "./server/auth";
import { pruneExpired } from "./server/db/prune";
import { demoEnabled } from "./server/demo/mode";
import { retryErasures } from "./server/erasure";
import { handleFileRequest, isFileRequest } from "./server/files";
import { handleGitHubRequest, isGitHubRequest } from "./server/github";
import { handleGitHubAppRequest, isGitHubAppRequest } from "./server/github-app";
import { handleIntakeEmail } from "./server/intake-email";
import { handleIntakeFormRequest, isIntakeFormRequest } from "./server/intake-form";
import { handleMcpRequest, isMcpRequest } from "./server/mcp";
import { newNonce, withSecurityHeaders } from "./server/security-headers";
import { handleSyncRequest, isSyncRequest } from "./server/sync";
import { handleUnsubscribeRequest, isUnsubscribeRequest } from "./server/unsubscribe";

export { RateLimiter } from "./server/rate-limit";
export { WorkspaceDO } from "./server/workspace-do";

/** OAuth discovery documents for MCP clients. Better Auth serves them at the root. */
const OAUTH_DISCOVERY =
	/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/|$)/;

/**
 * A branch's Preview gets none of the Worker's bindings or secrets. Nothing works without the
 * database. Without the secret, Better Auth signs with the default in its source, because with no
 * NODE_ENV on a Worker it does not know this is production. So such a deployment serves nothing else.
 */
function isSetUp() {
	return Boolean(env.DB && env.BETTER_AUTH_SECRET);
}

function notSetUp() {
	return new Response(
		"This deployment has no database or no BETTER_AUTH_SECRET, so it serves nothing. A Preview of a branch gets neither by itself: see Preview builds in docs/self-hosting.md.\n",
		{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
	);
}

function route(request: Request, nonce: string): Response | Promise<Response> {
	if (!isSetUp()) return notSetUp();
	const url = new URL(request.url);
	// Sync is handled before TanStack Start so WebSocket upgrade responses pass through untouched.
	if (isSyncRequest(url)) return handleSyncRequest(request);
	if (isMcpRequest(url)) return handleMcpRequest(request);
	// Uploads stream to R2 as they arrive, without TanStack Start reading the body first.
	if (isFileRequest(url)) return handleFileRequest(request);
	// GitHub signs the raw body, so it reaches the workspace unread.
	if (isGitHubAppRequest(url)) return handleGitHubAppRequest(request);
	if (isGitHubRequest(url)) return handleGitHubRequest(request);
	// Mail clients post here for one-click unsubscribe, with no session.
	if (isUnsubscribeRequest(url)) return handleUnsubscribeRequest(request);
	// A team's public request form: a page of its own, for people who are not signed in.
	if (isIntakeFormRequest(url)) return handleIntakeFormRequest(request);
	if (OAUTH_DISCOVERY.test(url.pathname)) return handleAuthRequest(request);
	return handler.fetch(request, { context: { nonce } });
}

export default {
	async fetch(request) {
		const nonce = newNonce();
		const response = await route(request, nonce);
		// Vite's dev server adds inline scripts of its own for hot reload, which have no nonce.
		if (import.meta.env.DEV) return response;
		return withSecurityHeaders(request, response, { nonce, oidcIssuer: env.OIDC_ISSUER });
	},
	// Email Routing sends mail for teams' intake addresses here (INTAKE_EMAIL_DOMAIN).
	async email(message) {
		if (!isSetUp()) {
			// Nobody could sign in to read what this filed, so the sender hears it went nowhere. A bounce
			// or an out-of-office reply would only come back, so it is dropped, as an address that works
			// drops it.
			if (!isAutomated(message.headers)) {
				message.setReject("This deployment is not set up to take email");
			}
			return;
		}
		await handleIntakeEmail(message);
	},
	// Every deployment clears what is past its time once a day. The demo's Cron Trigger runs every 10
	// minutes instead, and deletes its visitors first, the promise it has to keep.
	async scheduled() {
		if (demoEnabled()) {
			const { cleanUpDemo } = await import("./server/demo/cleanup");
			await cleanUpDemo();
		}
		await retryErasures(db);
		await pruneExpired(db);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
