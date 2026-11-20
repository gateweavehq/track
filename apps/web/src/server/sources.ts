import { isAdminRole, type SourceAction } from "@gateweave/track-protocol";
import { appOrigin, db, getAuth } from "./auth";
import { demoEnabled } from "./demo/mode";
import { applySourceAction } from "./source-admin";
import { sourceKeys } from "./source-keys";
import { findMembership, workspaceStub } from "./workspaces";

async function admin(slug: string, request: Request) {
	if (demoEnabled()) return null;
	const session = await getAuth().api.getSession({ headers: request.headers });
	const member = session && (await findMembership(db, slug, session.user.id));
	if (!member || !isAdminRole(member.profile.role)) return null;
	return { stub: workspaceStub(member), workspaceId: member.workspaceId, id: member.profile.id };
}

export async function readSources(slug: string, request: Request) {
	const found = await admin(slug, request);
	if (!found) return null;
	const sources = await found.stub.sourcesForAdmin(found.id);
	if (!sources.ok) return null;
	return { sources: sources.value, keys: await sourceKeys(db, found.workspaceId) };
}

export async function editSource(slug: string, request: Request, action: SourceAction) {
	if (request.headers.get("origin") !== appOrigin(request))
		return { ok: false as const, message: "Wrong request origin" };
	const found = await admin(slug, request);
	if (!found) return { ok: false as const, message: "Workspace not found" };
	return applySourceAction(
		db,
		found.workspaceId,
		(command) => found.stub.manageSource(found.id, command),
		action,
	);
}
