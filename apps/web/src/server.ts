import handler from "@tanstack/react-start/server-entry";
import { getAuth } from "./server/auth";
import { handleMcpRequest, isMcpRequest } from "./server/mcp";
import { handleSyncRequest, isSyncRequest } from "./server/sync";

export { WorkspaceDO } from "@gateweave/track-sync-server";

/** OAuth discovery documents for MCP clients. Better Auth serves them at the root. */
const OAUTH_DISCOVERY =
	/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/|$)/;

export default {
	fetch(request) {
		const url = new URL(request.url);
		// Sync is handled before TanStack Start so WebSocket upgrade responses pass through untouched.
		if (isSyncRequest(url)) return handleSyncRequest(request);
		if (isMcpRequest(url)) return handleMcpRequest(request);
		if (OAUTH_DISCOVERY.test(url.pathname)) return getAuth().handler(request);
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
