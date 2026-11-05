import handler from "@tanstack/react-start/server-entry";
import { db, handleAuthRequest } from "./server/auth";
import { pruneExpired } from "./server/db/prune";
import { demoEnabled } from "./server/demo/mode";
import { handleFileRequest, isFileRequest } from "./server/files";
import { handleGitHubRequest, isGitHubRequest } from "./server/github";
import { handleGitHubAppRequest, isGitHubAppRequest } from "./server/github-app";
import { handleIntakeEmail } from "./server/intake-email";
import { handleIntakeFormRequest, isIntakeFormRequest } from "./server/intake-form";
import { handleMcpRequest, isMcpRequest } from "./server/mcp";
import { handleSyncRequest, isSyncRequest } from "./server/sync";
import { handleUnsubscribeRequest, isUnsubscribeRequest } from "./server/unsubscribe";

export { RateLimiter } from "./server/rate-limit";
export { WorkspaceDO } from "./server/workspace-do";

/** OAuth discovery documents for MCP clients. Better Auth serves them at the root. */
const OAUTH_DISCOVERY =
	/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/|$)/;

export default {
	fetch(request) {
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
		return handler.fetch(request);
	},
	// Email Routing sends mail for teams' intake addresses here (INTAKE_EMAIL_DOMAIN).
	async email(message) {
		await handleIntakeEmail(message);
	},
	// Every deployment clears what is past its time once a day. The demo's Cron Trigger runs every 10
	// minutes instead, and deletes its visitors first, the promise it has to keep.
	async scheduled() {
		if (demoEnabled()) {
			const { cleanUpDemo } = await import("./server/demo/cleanup");
			await cleanUpDemo();
		}
		await pruneExpired(db);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
