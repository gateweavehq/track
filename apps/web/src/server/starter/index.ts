import type { MemberProfile } from "@gateweave/track-sync-server";
import { workspaceStub } from "../workspaces";
import { guideSteps } from "./guide";

export type GuideOutcome = { ok: true; teamKey: string } | { ok: false; message: string };

/**
 * Adds the guided team and its issues to a workspace, made by `owner` through the same mutations
 * people send, so activity, the oplog and webhooks see ordinary writes. The Durable Object checks
 * that `owner` may create teams.
 */
export async function startGuide(
	workspace: { id: string; name: string; jurisdiction: string | null },
	owner: MemberProfile,
	mcpUrl: string | null,
): Promise<GuideOutcome> {
	const stub = workspaceStub({ workspaceId: workspace.id, jurisdiction: workspace.jurisdiction });
	const { teamKey, mutations } = guideSteps({
		workspace,
		ownerId: owner.id,
		mcpUrl,
		newId: () => crypto.randomUUID(),
	});
	// One call, as the workspace may be in a jurisdiction far from this request.
	const results = await stub.mutateMany(
		"guided-start",
		mutations.map((mutation) => ({
			member: owner,
			mutationId: crypto.randomUUID(),
			body: mutation,
		})),
	);
	const index = results.length - 1;
	const last = results[index];
	if (results.length === mutations.length && last?.ok !== false) return { ok: true, teamKey };
	if (last?.ok !== false) throw new Error("Guided start stopped without a reason.");
	// The team comes first, so a refusal there leaves nothing behind: the workspace already has its
	// guided team, or a team with that key, or the caller is not an admin.
	if (index === 0) return { ok: false, message: last.message };
	throw new Error(
		`Guided start failed at step ${index + 1} of ${mutations.length} (${mutations[index]?.name}): ${last.reason}: ${last.message}`,
	);
}
