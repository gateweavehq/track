import handler from "@tanstack/react-start/server-entry";
import { getAuth } from "./server/auth";
import { demoEnabled } from "./server/demo/mode";
import { handleFileRequest, isFileRequest } from "./server/files";
import { handleGitHubRequest, isGitHubRequest } from "./server/github";
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
		if (isGitHubRequest(url)) return handleGitHubRequest(request);
		// Mail clients post here for one-click unsubscribe, with no session.
		if (isUnsubscribeRequest(url)) return handleUnsubscribeRequest(request);
		if (OAUTH_DISCOVERY.test(url.pathname)) return getAuth().handler(request);
		return handler.fetch(request);
	},
	// The demo deployment has a Cron Trigger; nothing else schedules this.
	async scheduled() {
		if (!demoEnabled()) return;
		const { cleanUpDemo } = await import("./server/demo/cleanup");
		await cleanUpDemo();
	},
} satisfies ExportedHandler<Cloudflare.Env>;
