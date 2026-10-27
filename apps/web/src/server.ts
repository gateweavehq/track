import handler from "@tanstack/react-start/server-entry";
import { handleSyncRequest, isSyncRequest } from "./server/sync";

export { WorkspaceDO } from "@gateweave/track-sync-server";

export default {
	fetch(request) {
		// Sync is handled before TanStack Start so WebSocket upgrade responses pass through untouched.
		if (isSyncRequest(new URL(request.url))) return handleSyncRequest(request);
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
