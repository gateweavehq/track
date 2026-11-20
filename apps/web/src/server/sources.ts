import { isAdminRole, type SourceAction, type SourceRestore } from "@gateweave/track-protocol";
import { importId } from "#/lib/import/plan";
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
	const keys = await sourceKeys(db, found.workspaceId);
	const sources = await found.stub.sourcesForAdmin(found.id);
	if (!sources.ok) return null;
	const generations = new Map(sources.value.map((source) => [source.id, source.generation]));
	return {
		sources: sources.value.map(({ generation: _, ...source }) => source),
		keys: keys.map((key) => {
			const generation = generations.get(key.sourceId);
			return generation && !key.id.startsWith(generation) ? { ...key, stale: true } : key;
		}),
	};
}

export async function editSource(slug: string, request: Request, action: SourceAction) {
	if (request.headers.get("origin") !== appOrigin(request))
		return { ok: false as const, message: "Wrong request origin" };
	const found = await admin(slug, request);
	if (!found) return { ok: false as const, message: "Workspace not found" };
	return applySourceAction(
		db,
		found.workspaceId,
		(command) =>
			command.kind === "prepareRevoke" || command.kind === "keyRevoked"
				? found.stub.revokeSourceKey(found.id, command)
				: found.stub.manageSource(found.id, command),
		action,
	);
}

export async function restoreImportedSource(slug: string, request: Request, input: SourceRestore) {
	if (request.headers.get("origin") !== appOrigin(request))
		return { ok: false as const, message: "Wrong request origin" };
	const found = await admin(slug, request);
	if (!found)
		return { ok: false as const, message: "Sources and signals need an owner or admin to import." };
	const id = await importId("track-source:" + input.source.id);
	if (input.signals.some((signal) => signal.sourceId !== input.source.id))
		return { ok: false as const, message: "Invalid signal for this source" };
	const answer = await found.stub.restoreSource(found.id, {
		exportedAt: input.exportedAt,
		source: { ...input.source, id },
		signals: await Promise.all(
			input.signals.map(async (signal) => ({
				...signal,
				sourceId: id,
				issueId: signal.issueId === null ? null : await importId("track:" + signal.issueId),
			})),
		),
	});
	return answer.ok
		? { ok: true as const, value: answer.value }
		: { ok: false as const, message: answer.message };
}
