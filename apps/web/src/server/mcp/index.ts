import type { MutationInput } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import type { IssueQuery } from "@gateweave/track-sync-server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDpopReplayStore } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { db, getAuth, mcpResource } from "../auth";
import { findAgentByKey, isAgentKey } from "../auth/agents";
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
 * People's agents authenticate with an OAuth access token issued by Track's own authorization
 * server (Better Auth's MCP plugin), bound to this endpoint and scoped to `track`, and act as the
 * person who approved them. Agent members authenticate with their key and act as themselves, in
 * their one workspace. Session cookies are never accepted here, so a web page cannot make a
 * signed-in browser call it.
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
		// protectResource only lets verified tokens through, and they always carry both, as do
		// agent keys once found.
		if (typeof userId !== "string" || !authInfo?.clientId) {
			throw new Error("MCP request without verified credentials");
		}
		const { workspaceId, slug } = authInfo.extra ?? {};
		const only =
			typeof workspaceId === "string" && typeof slug === "string" ? { workspaceId, slug } : null;
		return createTrackServer(accessFor(userId, authInfo.clientId, origin, only));
	});

	const serveAgent = async (request: Request, key: string) => {
		const agent = await findAgentByKey(db, key);
		if (!agent) {
			// No resource metadata: an agent key is not something OAuth can replace.
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Invalid agent key" }, id: null },
				{
					status: 401,
					headers: {
						"WWW-Authenticate": `Bearer error="invalid_token", error_description="The agent key was revoked, or its agent deleted"`,
					},
				},
			);
		}
		return mcpHandler.fetch(request, {
			authInfo: {
				token: key,
				// One id per agent, whichever key it uses, like one per OAuth client.
				clientId: `agent:${agent.userId}`,
				scopes: [MCP_SCOPE],
				resource: new URL(resource),
				extra: { userId: agent.userId, workspaceId: agent.workspaceId, slug: agent.slug },
			},
		});
	};

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
		const key = bearerToken(request);
		if (key && isAgentKey(key)) return serveAgent(request, key);
		if (!handler) {
			const { baseURL, internalAdapter } = await getAuth().$context;
			handler = protectResource(
				{
					issuer: baseURL,
					resource,
					requiredScopes: [MCP_SCOPE],
					// offline_access lets clients refresh tokens instead of asking the user again.
					challengeScopes: [MCP_SCOPE, "offline_access"],
					jwks: () => getAuth().api.getJwks(),
					dpopReplayStore: createDpopReplayStore(internalAdapter),
				},
				serve,
			);
		}
		return handler(request);
	};
}

function bearerToken(request: Request): string | null {
	return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

/**
 * What a caller reaches: every workspace the user is in, or, for an agent's key, the one
 * workspace the key was made for.
 */
function accessFor(
	userId: string,
	oauthClientId: string,
	origin: string,
	only: { workspaceId: string; slug: string } | null,
): TrackAccess {
	// Field-level conflict detection treats a client's own writes as never conflicting, so each
	// OAuth client gets one stable id. Mutation ids stay unique per call.
	const clientId = `mcp:${oauthClientId}`.slice(0, 64);
	return {
		origin,
		async workspaces() {
			const all = await listWorkspaces(db, userId);
			return only ? all.filter((workspace) => workspace.slug === only.slug) : all;
		},
		async workspace(slug) {
			const membership = await findMembership(db, slug, userId);
			if (!membership || (only && membership.workspaceId !== only.workspaceId)) return null;
			const stub = workspaceStub(membership.workspaceId);
			const access: WorkspaceAccess = {
				slug,
				me: membership.profile,
				directory: () => stub.directory(),
				issues: (query: IssueQuery) => stub.issues(query),
				issue: (id) => stub.issue(id),
				issueByKey: (teamKey, number) => stub.issueByKey(teamKey, number),
				comments: (issueId) => stub.comments(issueId),
				lastSortOrder: () => stub.lastSortOrder(),
				mutate: (mutation: MutationInput) =>
					stub.mutate(membership.profile, clientId, uuidv7(), mutation),
			};
			return access;
		},
	};
}
