import { isAdminRole } from "@gateweave/track-protocol";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import type { AgentInfo } from "#/server/auth/agents";

export type { AgentInfo, AgentKeyInfo } from "#/server/auth/agents";

/**
 * The workspace's agents and their keys, for admins, with the MCP endpoint they connect to (null
 * where the server has no pinned base URL, so no MCP). Null if the caller is not a member.
 */
export const getWorkspaceAgents = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { getAuth, db, mcpResource } = await import("#/server/auth");
		const auth = getAuth();
		const { findMembership } = await import("#/server/workspaces");
		const headers = getRequestHeaders();
		const session = await auth.api.getSession({ headers });
		const membership = session && (await findMembership(db, slug, session.user.id));
		if (!membership) return null;

		const admin = isAdminRole(membership.profile.role);
		const agents: AgentInfo[] = admin
			? await auth.api.listAgents({ query: { organizationId: membership.workspaceId }, headers })
			: [];
		return { admin, agents, mcpUrl: mcpResource ?? null };
	});
