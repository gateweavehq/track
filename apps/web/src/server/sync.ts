import { MEMBER_HEADER } from "@tangent/sync-server";
import { auth, db } from "./auth";
import { findMembership, workspaceStub } from "./workspaces";

const SYNC_ROUTE = /^\/api\/sync\/([^/]+)\/(snapshot|socket)$/;

export function isSyncRequest(url: URL): boolean {
	return url.pathname.startsWith("/api/sync/");
}

/**
 * Gateway to a workspace's Durable Object. The DO has no public route; every request passes
 * through here, where the session and membership are checked against D1.
 *
 *   GET /api/sync/:slug/snapshot  full workspace state (JSON)
 *   GET /api/sync/:slug/socket    WebSocket for live sync
 */
export async function handleSyncRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const match = SYNC_ROUTE.exec(url.pathname);
	if (!match) return error(404, "Not found");
	if (request.method !== "GET") return error(405, "Method not allowed");

	const [, slug, endpoint] = match as unknown as [string, string, "snapshot" | "socket"];
	const isSocket = endpoint === "socket";
	if (isSocket && request.headers.get("Upgrade") !== "websocket") {
		return error(426, "Expected a WebSocket upgrade");
	}
	// Session cookies ride along on cross-site WebSocket handshakes, so the origin must match.
	const origin = request.headers.get("Origin");
	if ((isSocket || origin) && origin !== url.origin) return error(403, "Cross-origin request");

	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) return error(401, "Not signed in");

	const membership = await findMembership(db, decodeURIComponent(slug), session.user.id);
	// Same response as a missing workspace, so slugs cannot be probed.
	if (!membership) return error(404, "Workspace not found");

	const stub = workspaceStub(membership.workspaceId);
	if (!isSocket) {
		return Response.json(await stub.snapshot(membership.profile), {
			headers: { "Cache-Control": "no-store" },
		});
	}
	return stub.fetch("https://workspace/socket", {
		headers: { Upgrade: "websocket", [MEMBER_HEADER]: JSON.stringify(membership.profile) },
	});
}

function error(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}
