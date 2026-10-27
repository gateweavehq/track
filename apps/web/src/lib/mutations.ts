import type { Issue, MutationInput } from "@tangent/protocol";
import type { SyncClient } from "@tangent/sync-client";
import { useSyncClient } from "@tangent/sync-client/react";
import { useCallback } from "react";
import { toast } from "sonner";

export type IssuePatch = Extract<MutationInput, { name: "issue.update" }>["args"]["patch"];

/**
 * Sends a mutation and reports invalid input as a toast. The server's verdict arrives later, and
 * a rejection is reported by the client's `onReject` handler.
 */
export function send(client: SyncClient, mutation: MutationInput): boolean {
	try {
		void client.mutate(mutation);
		return true;
	} catch {
		toast.error("That change is not valid");
		return false;
	}
}

/**
 * Updates an issue against the version the user was looking at, so the server can tell edits
 * made in ignorance of someone else's from edits made on top of them. Pass `baseVersion` when
 * the user started editing earlier than the issue on screen, such as in a long-lived text field.
 */
export function useUpdateIssue() {
	const client = useSyncClient();
	return useCallback(
		(issue: Issue, patch: IssuePatch, baseVersion = issue.version) =>
			send(client, {
				name: "issue.update",
				args: { id: issue.id, baseVersion, patch },
			}),
		[client],
	);
}
