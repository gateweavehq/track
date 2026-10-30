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
	workspace: { id: string; name: string },
	owner: MemberProfile,
	mcpUrl: string | null,
): Promise<GuideOutcome> {
	const stub = workspaceStub(workspace.id);
	const { teamKey, mutations } = guideSteps({
		workspace,
		ownerId: owner.id,
		mcpUrl,
		newId: () => crypto.randomUUID(),
	});
	for (const [index, mutation] of mutations.entries()) {
		const result = await stub.mutate(owner, "guided-start", crypto.randomUUID(), mutation);
		if (result.ok) continue;
		// The team comes first, so a refusal there leaves nothing behind: the workspace already
		// has its guided team, or a team with that key, or the caller is not an admin.
		if (index === 0) return { ok: false, message: result.message };
		throw new Error(
			`Guided start failed at step ${index + 1} of ${mutations.length} (${mutation.name}): ${result.reason}: ${result.message}`,
		);
	}
	return { ok: true, teamKey };
}
