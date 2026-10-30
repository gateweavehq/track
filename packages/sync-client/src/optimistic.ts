import {
	AGENT_CHANGE_KINDS,
	type Issue,
	isAdminRole,
	MAX_LABELS_PER_ISSUE,
	type ProposedChange,
} from "@gateweave/track-protocol";
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
			if (args.projectId !== null && !draft.get("project", args.projectId)) return;
			draft.put("issue", {
				...args,
				labelIds: [...new Set(args.labelIds)],
				// The server assigns the real number; this guess is replaced when the issue arrives.
				number: nextIssueNumber(draft, args.teamId),
				creatorId: userId,
				version: 0,
				createdAt: Math.min(args.createdAt ?? now, now),
				updatedAt: now,
			});
			return;
		}
		case "issue.update": {
			const { id, patch } = mutation.args;
			const issue = draft.get("issue", id);
			if (patch.projectId && !draft.get("project", patch.projectId)) return;
			if (issue) draft.put("issue", { ...issue, ...patch, updatedAt: now });
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
			for (const proposal of [...draft.values("proposal")]) {
				if (proposal.issueId === id) draft.delete("proposal", proposal.id);
			}
			// Its relations go, and its sub-issues stay as top-level issues.
			for (const relation of [...draft.values("relation")]) {
				if (relation.issueId === id || relation.relatedIssueId === id) {
					draft.delete("relation", relation.id);
				}
			}
			for (const child of [...draft.values("issue")]) {
				if (child.parentId === id) draft.put("issue", { ...child, parentId: null, updatedAt: now });
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
		case "project.create": {
			const { id, ...fields } = mutation.args;
			if (draft.get("project", id) || isAgent(draft, userId) || !isLead(draft, fields.leadId)) {
				return;
			}
			draft.put("project", { id, ...fields, createdAt: now, updatedAt: now });
			return;
		}
		case "project.update": {
			const { id, patch } = mutation.args;
			const project = draft.get("project", id);
			if (!project || isAgent(draft, userId)) return;
			if (patch.leadId !== undefined && !isLead(draft, patch.leadId)) return;
			draft.put("project", { ...project, ...patch, updatedAt: now });
			return;
		}
		case "project.delete": {
			const { id } = mutation.args;
			const role = draft.get("member", userId)?.role;
			if (!draft.get("project", id) || role === undefined || !isAdminRole(role)) return;
			for (const issue of [...draft.values("issue")]) {
				if (issue.projectId === id)
					draft.put("issue", { ...issue, projectId: null, updatedAt: now });
			}
			draft.delete("project", id);
			return;
		}
		case "comment.create": {
			const { id, issueId, body } = mutation.args;
			if (draft.get("comment", id) || !draft.get("issue", issueId)) return;
			const createdAt = Math.min(mutation.args.createdAt ?? now, now);
			draft.put("comment", { id, issueId, body, authorId: userId, createdAt, updatedAt: now });
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
			if (comment.authorId !== userId && (role === undefined || !isAdminRole(role))) return;
			draft.delete("comment", comment.id);
			return;
		}
		case "relation.create": {
			const { id, type, issueId, relatedIssueId } = mutation.args;
			if (draft.get("relation", id) || issueId === relatedIssueId) return;
			if (!draft.get("issue", issueId) || !draft.get("issue", relatedIssueId)) return;
			// Two issues have one relation at most: the pair's current one is kept or replaced.
			for (const existing of [...draft.values("relation")]) {
				const pair =
					(existing.issueId === issueId && existing.relatedIssueId === relatedIssueId) ||
					(existing.issueId === relatedIssueId && existing.relatedIssueId === issueId);
				if (!pair) continue;
				if (existing.type === type && (type === "related" || existing.issueId === issueId)) return;
				draft.delete("relation", existing.id);
			}
			draft.put("relation", {
				id,
				type,
				issueId,
				relatedIssueId,
				creatorId: userId,
				createdAt: now,
			});
			return;
		}
		case "relation.delete": {
			draft.delete("relation", mutation.args.id);
			return;
		}
		case "agent.update": {
			const { id, patch } = mutation.args;
			const role = draft.get("member", userId)?.role;
			const agent = draft.get("member", id);
			if (role === undefined || !isAdminRole(role) || agent?.role !== "agent") return;
			if (patch.proposes === undefined) return;
			const wanted = new Set(patch.proposes);
			draft.put("member", {
				...agent,
				proposes: AGENT_CHANGE_KINDS.filter((kind) => wanted.has(kind)),
			});
			return;
		}
		case "proposal.accept": {
			const proposal = draft.get("proposal", mutation.args.id);
			const issue = proposal && draft.get("issue", proposal.issueId);
			// Once the server has decided, the proposal is gone and the issue already has the change.
			if (!proposal || !issue || draft.get("member", userId)?.role === "agent") return;
			const accepted = withChange(draft, issue, proposal.change, now);
			if (accepted) draft.put("issue", accepted);
			draft.delete("proposal", proposal.id);
			return;
		}
		case "proposal.dismiss": {
			if (draft.get("member", userId)?.role === "agent") return;
			draft.delete("proposal", mutation.args.id);
			return;
		}
	}
}

/** The issue with a proposed change made, or null where the server would not make it. */
function withChange(draft: Draft, issue: Issue, change: ProposedChange, now: number): Issue | null {
	switch (change.type) {
		case "title":
			return { ...issue, title: change.to, updatedAt: now };
		case "description":
			return { ...issue, description: change.to, updatedAt: now };
		case "status":
			return { ...issue, status: change.to, updatedAt: now };
		case "priority":
			return { ...issue, priority: change.to, updatedAt: now };
		case "assignee":
			return { ...issue, assigneeId: change.to, updatedAt: now };
		case "project":
			if (change.to !== null && !draft.get("project", change.to)) return null;
			return { ...issue, projectId: change.to, updatedAt: now };
		case "label": {
			const has = issue.labelIds.includes(change.labelId);
			if (!change.added) return has ? withoutLabel(issue, change.labelId, now) : null;
			if (has || !draft.get("label", change.labelId)) return null;
			if (issue.labelIds.length >= MAX_LABELS_PER_ISSUE) return null;
			return { ...issue, labelIds: [...issue.labelIds, change.labelId], updatedAt: now };
		}
	}
}

function isAgent(draft: Draft, userId: string): boolean {
	return draft.get("member", userId)?.role === "agent";
}

/** Whether the server would take this member as a project's lead: a person, or no one. */
function isLead(draft: Draft, leadId: string | null): boolean {
	if (leadId === null) return true;
	const lead = draft.get("member", leadId);
	return lead !== undefined && lead.role !== "agent" && lead.removedAt === null;
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
