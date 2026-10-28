import { isAdminRole } from "@gateweave/track-protocol";
import type { WorkspaceLink } from "@gateweave/track-sync-server";
import { appOrigin, db, getAuth } from "./auth";
import { demoEnabled } from "./demo/mode";
import { findMembership, workspaceStub } from "./workspaces";

/**
 * The gateway to a workspace's webhooks. Membership is checked against D1 here; the Durable
 * Object then refuses anyone who is not an admin, given the verified member.
 */
export async function webhookAccess(slug: string, request: Request) {
	const session = await getAuth().api.getSession({ headers: request.headers });
	const membership = session && (await findMembership(db, slug, session.user.id));
	if (!membership) return null;
	const link: WorkspaceLink = { id: membership.workspaceId, slug, origin: appOrigin(request) };
	return {
		member: membership.profile,
		admin: isAdminRole(membership.profile.role),
		link,
		stub: workspaceStub(membership.workspaceId),
	};
}

/**
 * The public demo sends no webhooks: anyone can make a sandbox there, and it should not post to
 * URLs on their behalf.
 */
export const webhooksEnabled = () => !demoEnabled();
