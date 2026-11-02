import type { Issue, MutationInput } from "@gateweave/track-protocol";
import type { SyncClient } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
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

/** One mutation in a batch, with the key of the issue it changes, to name it if it fails. */
export interface BatchChange {
	key: string;
	mutation: MutationInput;
}

/**
 * Sends many changes at once, as bulk edit does: the replica, storage and the other tabs take them
 * in one go. The server applies or refuses each on its own; refusals are summed up in one toast
 * that names the issues left as they were, instead of a toast for each.
 */
export function sendBatch(client: SyncClient, changes: readonly BatchChange[]): boolean {
	if (changes.length === 0) return true;
	let results: Promise<number>[];
	try {
		results = client.mutateAll(
			changes.map((change) => change.mutation),
			{ report: false },
		);
	} catch {
		toast.error("That change is not valid");
		return false;
	}
	void Promise.allSettled(results).then((settled) => {
		const failed: string[] = [];
		let reason: string | undefined;
		settled.forEach((result, index) => {
			if (result.status !== "rejected") return;
			const change = changes[index];
			if (change) failed.push(change.key);
			reason ??= result.reason instanceof Error ? result.reason.message : undefined;
		});
		if (failed.length === 0) return;
		const { title, description } = batchFailure(failed, changes.length, reason);
		toast.error(title, { description });
	});
	return true;
}

/** How a batch that partly failed is reported: how many, which issues, and the first reason. */
export function batchFailure(
	keys: readonly string[],
	total: number,
	reason?: string,
): { title: string; description: string } {
	const title =
		keys.length === total
			? total === 1
				? "Your change was not saved"
				: `None of the ${total} changes were saved`
			: `${keys.length} of ${total} changes were not saved`;
	const unique = [...new Set(keys)];
	const named =
		unique.length > 5
			? `${unique.slice(0, 5).join(", ")} and ${unique.length - 5} more`
			: unique.join(", ");
	const description = `Left as they were: ${named}.${reason ? ` ${reason}` : ""}`;
	return { title, description };
}
