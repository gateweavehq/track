import type { Draft, PendingMutation } from "./store";

/**
 * Predicts a mutation's effect so the UI can show it before the server confirms it. Mirrors the
 * server's mutation logic closely enough to be convincing; the server's result always replaces
 * the prediction. Anything the server would reject is skipped here rather than reported, and the
 * rejection arrives from the server.
 *
 * Runs again on every rebase, including after the server has applied the mutation but before its
 * ack arrives, so each case must be safe to apply to state that already contains its effect.
 */
export function applyOptimistic(draft: Draft, pending: PendingMutation, userId: string): void {
	const { mutation, createdAt: now } = pending;
	switch (mutation.name) {
		case "team.create": {
			const { id, key, name } = mutation.args;
			if (draft.get("team", id)) return;
			draft.put("team", { id, key, name, createdAt: now, updatedAt: now });
			return;
		}
		case "team.update": {
			const team = draft.get("team", mutation.args.id);
			if (team) draft.put("team", { ...team, ...mutation.args.patch, updatedAt: now });
			return;
		}
		case "issue.create": {
			const args = mutation.args;
			if (draft.get("issue", args.id) || !draft.get("team", args.teamId)) return;
			draft.put("issue", {
				...args,
				// The server assigns the real number; this guess is replaced when the issue arrives.
				number: nextIssueNumber(draft, args.teamId),
				creatorId: userId,
				version: 0,
				createdAt: now,
				updatedAt: now,
			});
			return;
		}
		case "issue.update": {
			const issue = draft.get("issue", mutation.args.id);
			if (issue) draft.put("issue", { ...issue, ...mutation.args.patch, updatedAt: now });
			return;
		}
		case "issue.delete":
			draft.delete("issue", mutation.args.id);
			return;
	}
}

function nextIssueNumber(draft: Draft, teamId: string): number {
	let max = 0;
	for (const issue of draft.values("issue")) {
		if (issue.teamId === teamId && issue.number > max) max = issue.number;
	}
	return max + 1;
}
