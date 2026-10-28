import { deleteIdbReplica, deleteIdbReplicas } from "@gateweave/track-sync-client";
import { forgetAllWorkspaces, forgetKnownWorkspace } from "./offline";

/** Where this browser stores a user's copy of a workspace. Ids, so a renamed workspace keeps it. */
export function replicaKey(userId: string, workspaceId: string): string {
	return `${userId}:${workspaceId}`;
}

/**
 * Deletes this browser's copy of a workspace, once the user has left it or lost access. A browser
 * may be shared, so it must not keep data its user can no longer see.
 */
export function forgetWorkspace(userId: string, workspaceId: string): Promise<void> {
	forgetKnownWorkspace({ id: workspaceId });
	return deleteIdbReplica(replicaKey(userId, workspaceId));
}

/** Deletes everything this browser keeps for the signed-in user, when they sign out. */
export async function forgetEverything(): Promise<void> {
	forgetAllWorkspaces();
	await deleteIdbReplicas().catch(() => {});
}
