import type { MutationInput } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import type { IssueQuery } from "@gateweave/track-sync-server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDpopReplayStore } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { auth, db, mcpResource } from "../auth";
import { MCP_SCOPE } from "../auth/config";
import { findMembership, listWorkspaces, workspaceStub } from "../workspaces";
import { protectResource } from "./protect";
import { createTrackServer, type TrackAccess, type WorkspaceAccess } from "./tools";

const MCP_PATH = "/mcp";

export function isMcpRequest(url: URL): boolean {
	return url.pathname === MCP_PATH;
}

/**
 * Gateway for AI agents. Like the sync gateway, it is the only way to a workspace's Durable
 * Object: every tool call resolves the workspace to the caller's membership in D1 first.
 *
 * Callers authenticate with an OAuth access token issued by Track's own authorization server
 * (Better Auth's MCP plugin), bound to this endpoint and scoped to `track`. Session cookies are
 * never accepted here, so a web page cannot make a signed-in browser call it.
 */
export function handleMcpRequest(request: Request): Promise<Response> | Response {
	if (!protectedHandler) return Response.json({ error: "Not found" }, { status: 404 });
	return protectedHandler(request);
}

const protectedHandler = mcpResource ? protect(mcpResource) : null;

function protect(resource: string) {
	const origin = new URL(resource).origin;
	const mcpHandler = createMcpHandler(({ authInfo }) => {
		const userId = authInfo?.extra?.userId;
		// protectResource only lets verified tokens through, and they always carry both.
		if (typeof userId !== "string" || !authInfo?.clientId) {
			throw new Error("MCP request without verified credentials");
		}
		return createTrackServer(accessFor(userId, authInfo.clientId, origin));
	});

	const serve = (request: Request, claims: JWTPayload) => {
		const clientId = typeof claims.azp === "string" ? claims.azp : claims.client_id;
		return mcpHandler.fetch(request, {
			authInfo: {
				token: request.headers.get("Authorization")?.replace(/^\S+\s+/, "") ?? "",
				clientId: typeof clientId === "string" ? clientId : "",
				scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
				expiresAt: claims.exp,
				resource: new URL(resource),
				extra: { userId: claims.sub },
			},
		});
	};

	// Built on the first request, once Better Auth's context has resolved. The handler itself is
	// kept rather than a promise of it, so no request waits on work another request started.
	let handler: ((request: Request) => Promise<Response>) | undefined;
	return async (request: Request) => {
		if (!handler) {
			const { baseURL, internalAdapter } = await auth.$context;
			handler = protectResource(
				{
					issuer: baseURL,
					resource,
					requiredScopes: [MCP_SCOPE],
					// offline_access lets clients refresh tokens instead of asking the user again.
					challengeScopes: [MCP_SCOPE, "offline_access"],
					jwks: () => auth.api.getJwks(),
					dpopReplayStore: createDpopReplayStore(internalAdapter),
				},
				serve,
			);
		}
		return handler(request);
	};
}

function accessFor(userId: string, oauthClientId: string, origin: string): TrackAccess {
	// Field-level conflict detection treats a client's own writes as never conflicting, so each
	// OAuth client gets one stable id. Mutation ids stay unique per call.
	const clientId = `mcp:${oauthClientId}`.slice(0, 64);
	return {
		origin,
		workspaces: () => listWorkspaces(db, userId),
		async workspace(slug) {
			const membership = await findMembership(db, slug, userId);
			if (!membership) return null;
			const stub = workspaceStub(membership.workspaceId);
			const access: WorkspaceAccess = {
				slug,
				me: membership.profile,
				directory: () => stub.directory(),
				issues: (query: IssueQuery) => stub.issues(query),
				issue: (id) => stub.issue(id),
				issueByKey: (teamKey, number) => stub.issueByKey(teamKey, number),
				lastSortOrder: () => stub.lastSortOrder(),
				mutate: (mutation: MutationInput) =>
					stub.mutate(membership.profile, clientId, uuidv7(), mutation),
			};
			return access;
		},
	};
}
