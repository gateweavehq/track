import type { Issue, MutationInput } from "@gateweave/track-protocol";
import type { MutationError, SyncClient } from "@gateweave/track-sync-client";
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
	} catch (error) {
		notSent(error);
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

/** A change the server refused: what it changed, such as an issue's key, and why. */
export interface Failure {
	key: string;
	reason: string;
}

/**
 * Sends many changes at once, as bulk edit does: the replica, storage and the other tabs take them
 * in one go. The server applies or refuses each on its own; refusals are summed up in one toast
 * that names the issues left as they were, by reason, instead of a toast for each.
 */
export function sendBatch(client: SyncClient, changes: readonly BatchChange[]): boolean {
	if (changes.length === 0) return true;
	let results: Promise<number>[];
	try {
		results = client.mutateAll(
			changes.map((change) => change.mutation),
			{ report: false },
		);
	} catch (error) {
		notSent(error);
		return false;
	}
	void Promise.allSettled(results).then((settled) => {
		const failures: Failure[] = [];
		settled.forEach((result, index) => {
			const change = changes[index];
			if (result.status !== "rejected" || !change) return;
			failures.push({ key: change.key, reason: reasonOf(result.reason) });
		});
		if (failures.length === 0) return;
		const { title, description } = batchFailure(failures, changes.length);
		toast.error(title, { description });
	});
	return true;
}

/**
 * Names a refused change in a summary: the key of the issue it changed while that issue is still
 * here, or else the change's name and the id it targeted. Refusals are listed by name and a name
 * is listed once, so a bare "A change" would fold every refusal of a deleted issue into one.
 */
export function changeName(
	mutation: Pick<MutationInput, "name" | "args">,
	keyOf: (issueId: string) => string | undefined,
): string {
	const args = mutation.args as { id?: unknown; issueId?: unknown };
	const target =
		typeof args.issueId === "string" ? args.issueId : typeof args.id === "string" ? args.id : null;
	if (target === null) return mutation.name;
	return keyOf(target) ?? `${mutation.name} ${target}`;
}

/**
 * Reports the server's refusals of changes that have no caller waiting, such as those queued
 * offline before a reload. Refusals that arrive together become one toast, as a batch's do,
 * rather than one each.
 */
export function rejectionReporter(
	describe: (error: MutationError) => string,
	{ window = 250 }: { window?: number } = {},
): (error: MutationError) => void {
	let pending: Failure[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (error) => {
		pending.push({ key: describe(error), reason: reasonOf(error) });
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			const failures = pending;
			pending = [];
			timer = undefined;
			const [only] = failures;
			if (failures.length === 1 && only) {
				toast.error("Your change was not saved", { description: sentence(only.reason) });
				return;
			}
			const { title, description } = batchFailure(failures);
			toast.error(title, { description });
		}, window);
	};
}

/**
 * How a batch that partly failed is reported: how many, and which issues were left as they were
 * for each reason. Without `total`, as for refusals collected after the fact, only how many.
 */
export function batchFailure(
	failures: readonly Failure[],
	total?: number,
): { title: string; description: string } {
	const count = failures.length;
	const title =
		total === undefined
			? count === 1
				? "Your change was not saved"
				: `${count} changes were not saved`
			: count === total
				? total === 1
					? "Your change was not saved"
					: `None of the ${total} changes were saved`
				: `${count} of ${total} changes were not saved`;
	const byReason = new Map<string, string[]>();
	for (const { key, reason } of failures) {
		const keys = byReason.get(reason) ?? [];
		if (!keys.includes(key)) keys.push(key);
		byReason.set(reason, keys);
	}
	const groups = [...byReason];
	const shown = groups.slice(0, 3).map(([reason, keys]) => `${listed(keys)}: ${sentence(reason)}`);
	const rest = groups.slice(3).reduce((sum, [, keys]) => sum + keys.length, 0);
	if (rest > 0) shown.push(`${rest} more for other reasons.`);
	return { title, description: shown.join(" ") };
}

/** Says why a change could not even be queued: invalid input, or a tab no longer syncing. */
function notSent(error: unknown) {
	if (error instanceof Error && error.name === "ZodError") toast.error("That change is not valid");
	else toast.error("This tab has stopped syncing", { description: "Reload the page to go on." });
}

function reasonOf(error: unknown): string {
	const message = (error as { message?: unknown } | null)?.message;
	return typeof message === "string" && message ? message : "Not saved";
}

/** Up to five names, then how many more. */
function listed(keys: readonly string[]): string {
	return keys.length > 5
		? `${keys.slice(0, 5).join(", ")} and ${keys.length - 5} more`
		: keys.join(", ");
}

/** A reason as a sentence: capitalized, ending with a full stop. */
function sentence(text: string): string {
	const trimmed = text.trim();
	const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
