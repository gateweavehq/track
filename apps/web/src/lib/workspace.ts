import { isAdminRole } from "@gateweave/track-protocol";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

/** The signed-in user's membership in the workspace with this slug, or null. */
export const getWorkspace = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { getAuth, db } = await import("#/server/auth");
		const auth = getAuth();
		const { findMembership } = await import("#/server/workspaces");
		const { demoEnabled } = await import("#/server/demo/mode");
		const session = await auth.api.getSession({ headers: getRequestHeaders() });
		if (!session) return null;
		const membership = await findMembership(db, slug, session.user.id);
		if (!membership) return null;
		return {
			id: membership.workspaceId,
			name: membership.workspaceName,
			userId: session.user.id,
			role: membership.profile.role,
			...(demoEnabled() && { demo: true }),
		};
	});

/**
 * Adds the guided start to the workspace with this slug: a team named after it, and a few issues
 * that show Track by doing, assigned to the caller. For admins; a workspace gets it once.
 */
export const startGuidedTeam = createServerFn({ method: "POST" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { getAuth, db, mcpResource } = await import("#/server/auth");
		const { findMembership } = await import("#/server/workspaces");
		const { startGuide } = await import("#/server/starter");
		const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
		const membership = session && (await findMembership(db, slug, session.user.id));
		if (!membership) return { ok: false as const, message: "Workspace not found" };
		if (!isAdminRole(membership.profile.role)) {
			return { ok: false as const, message: "Only workspace admins can add teams" };
		}
		return startGuide(
			{ id: membership.workspaceId, name: membership.workspaceName },
			membership.profile,
			mcpResource ?? null,
		);
	});
