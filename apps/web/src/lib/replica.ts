import { deleteIdbReplica } from "@tangent/sync-client";

/** Where this browser stores a user's copy of a workspace. Ids, so a renamed workspace keeps it. */
export function replicaKey(userId: string, workspaceId: string): string {
	return `${userId}:${workspaceId}`;
}

/**
 * Deletes this browser's copy of a workspace, once the user has left it or lost access. A browser
 * may be shared, so it must not keep data its user can no longer see.
 */
export function forgetWorkspace(userId: string, workspaceId: string): Promise<void> {
	return deleteIdbReplica(replicaKey(userId, workspaceId));
}
