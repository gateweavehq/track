import {
	LINK_HEADER,
	MEMBER_HEADER,
	SESSION_HEADER,
	type SocketSession,
	type WebhookResult,
	type WorkspaceLink,
} from "@gateweave/track-sync-server";
import { appOrigin, db, getAuth } from "./auth";
import { findMembership, workspaceStub } from "./workspaces";

const SYNC_ROUTE = /^\/api\/sync\/([^/]+)\/(snapshot|socket|archive|issues\/([^/]+))$/;

export function isSyncRequest(url: URL): boolean {
	return url.pathname.startsWith("/api/sync/");
}

/**
 * Gateway to a workspace's Durable Object. The DO has no public route; every request passes
 * through here, where the session and membership are checked against D1.
 *
 *   GET  /api/sync/:slug/snapshot     full workspace state (JSON)
 *   HEAD /api/sync/:slug/snapshot     access check only; clients use it to learn why a socket failed
 *   GET  /api/sync/:slug/socket       WebSocket for live sync
 *   GET  /api/sync/:slug/issues/:id   one issue whole, for an archived issue's page (JSON)
 *   GET  /api/sync/:slug/archive      archived issues whole, for exports, `?team=` for one team's:
 *                                     a page with `?page=1`, then `?after=` the `next` of the page
 *                                     before; without either, all in one answer, for v0.21.0
 */
export async function handleSyncRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const match = SYNC_ROUTE.exec(url.pathname);
	if (!match) return error(404, "Not found");

	const [, slug, path, issueId] = match as unknown as [string, string, string, string | undefined];
	const endpoint = issueId === undefined ? path : "issue";
	const isSocket = endpoint === "socket";
	const isProbe = request.method === "HEAD" && endpoint === "snapshot";
	if (request.method !== "GET" && !isProbe) return error(405, "Method not allowed");
	if (isSocket && request.headers.get("Upgrade") !== "websocket") {
		return error(426, "Expected a WebSocket upgrade");
	}
	// Session cookies ride along on cross-site WebSocket handshakes, so the origin must match.
	const origin = request.headers.get("Origin");
	if ((isSocket || origin) && origin !== url.origin) return error(403, "Cross-origin request");

	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return error(401, "Not signed in");

	const membership = await findMembership(db, decodeURIComponent(slug), session.user.id);
	// Same response as a missing workspace, so slugs cannot be probed.
	if (!membership) return error(404, "Workspace not found");
	if (isProbe) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

	const stub = workspaceStub(membership.workspaceId);
	if (endpoint === "snapshot") return json(await stub.snapshot(membership.profile));
	// Reads of what replicas leave out. The object checks the member again, and the input.
	if (endpoint === "issue") {
		let id: string;
		try {
			id = decodeURIComponent(issueId ?? "");
		} catch {
			return error(400, "Invalid issue id");
		}
		const result = await stub.issueDetails(membership.profile, { issueId: id });
		return answer(result, "Issue not found");
	}
	if (endpoint === "archive") {
		const teamId = url.searchParams.get("team");
		const paged = url.searchParams.has("page") || url.searchParams.has("after");
		if (!paged) {
			// v0.21.0 asks without paging and reads the whole list from one answer. Kept as it was
			// for tabs still on that build, until a later protocol bump. Too large to send whole is
			// an error, which that build shows, rather than a list cut short, which it would save.
			const whole = await stub.archivedIssues(membership.profile, { teamId });
			if (whole.ok && whole.value === "too_large") {
				return error(413, "Too many archived issues for one answer; reload to export them");
			}
			return answer(whole, "Not found");
		}
		if (url.searchParams.has("page") && url.searchParams.get("page") !== "1") {
			return error(400, "Invalid archive page");
		}
		const result = await stub.archivedIssuesPage(membership.profile, {
			teamId,
			after: url.searchParams.get("after"),
		});
		return answer(result, "Not found");
	}
	// The session is checked here only once, so the object holds on to which one it was and when it
	// runs out: signing out or revoking it closes the socket (`onSessionEnded` in auth), and so
	// does its expiry.
	const socketSession: SocketSession = {
		id: session.session.id,
		expiresAt: new Date(session.session.expiresAt).getTime(),
	};
	// The workspace records where it lives, for the links in its emails.
	const link: WorkspaceLink = {
		id: membership.workspaceId,
		slug: decodeURIComponent(slug),
		origin: appOrigin(request),
	};
	return stub.fetch("https://workspace/socket", {
		headers: {
			Upgrade: "websocket",
			[MEMBER_HEADER]: JSON.stringify(membership.profile),
			[LINK_HEADER]: JSON.stringify(link),
			[SESSION_HEADER]: JSON.stringify(socketSession),
		},
	});
}

/**
 * A read's result as a response. Refused, it is the same 404 as a missing workspace; an issue that
 * is not there, or never was, is a 404 of its own.
 */
function answer<T>(result: WebhookResult<T>, notFound: string): Response {
	if (result.ok) return json(result.value);
	if (result.reason === "invalid") return error(400, result.message);
	if (result.reason === "not_found") return error(404, notFound);
	return error(404, "Workspace not found");
}

function json(body: unknown): Response {
	return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

// Never cached either: a refusal or a failure is of the moment, and the next try must reach here.
function error(status: number, message: string): Response {
	return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
