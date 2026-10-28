import { type Issue, MAX_LABELS_PER_ISSUE } from "@gateweave/track-protocol";
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
			if (args.labelIds.some((labelId) => !draft.get("label", labelId))) return;
			draft.put("issue", {
				...args,
				labelIds: [...new Set(args.labelIds)],
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
		case "issue.delete": {
			const { id } = mutation.args;
			// The server drops the issue's comments and history with it.
			for (const comment of [...draft.values("comment")]) {
				if (comment.issueId === id) draft.delete("comment", comment.id);
			}
			for (const activity of [...draft.values("activity")]) {
				if (activity.issueId === id) draft.delete("activity", activity.id);
			}
			draft.delete("issue", id);
			return;
		}
		case "issue.addLabel": {
			const { id, labelId } = mutation.args;
			const issue = draft.get("issue", id);
			if (!issue || !draft.get("label", labelId) || issue.labelIds.includes(labelId)) return;
			if (issue.labelIds.length >= MAX_LABELS_PER_ISSUE) return;
			draft.put("issue", { ...issue, labelIds: [...issue.labelIds, labelId], updatedAt: now });
			return;
		}
		case "issue.removeLabel": {
			const { id, labelId } = mutation.args;
			const issue = draft.get("issue", id);
			if (!issue?.labelIds.includes(labelId)) return;
			draft.put("issue", withoutLabel(issue, labelId, now));
			return;
		}
		case "label.create": {
			const { id, name, color } = mutation.args;
			if (draft.get("label", id)) return;
			draft.put("label", { id, name, color, createdAt: now, updatedAt: now });
			return;
		}
		case "label.update": {
			const label = draft.get("label", mutation.args.id);
			if (label) draft.put("label", { ...label, ...mutation.args.patch, updatedAt: now });
			return;
		}
		case "label.delete": {
			const { id } = mutation.args;
			for (const issue of [...draft.values("issue")]) {
				if (issue.labelIds.includes(id)) draft.put("issue", withoutLabel(issue, id, now));
			}
			draft.delete("label", id);
			return;
		}
		case "comment.create": {
			const { id, issueId, body } = mutation.args;
			if (draft.get("comment", id) || !draft.get("issue", issueId)) return;
			draft.put("comment", { id, issueId, body, authorId: userId, createdAt: now, updatedAt: now });
			return;
		}
		case "comment.update": {
			const comment = draft.get("comment", mutation.args.id);
			if (!comment || comment.authorId !== userId || comment.body === mutation.args.body) return;
			draft.put("comment", { ...comment, body: mutation.args.body, updatedAt: now });
			return;
		}
		case "comment.delete": {
			const comment = draft.get("comment", mutation.args.id);
			if (!comment) return;
			const role = draft.get("member", userId)?.role;
			if (comment.authorId !== userId && (role === undefined || role === "member")) return;
			draft.delete("comment", comment.id);
			return;
		}
	}
}

function withoutLabel(issue: Issue, labelId: string, now: number): Issue {
	return { ...issue, labelIds: issue.labelIds.filter((id) => id !== labelId), updatedAt: now };
}

function nextIssueNumber(draft: Draft, teamId: string): number {
	let max = 0;
	for (const issue of draft.values("issue")) {
		if (issue.teamId === teamId && issue.number > max) max = issue.number;
	}
	return max + 1;
}
