import type { Issue, Proposal } from "@gateweave/track-protocol";
import { z } from "zod";

/** Search params of the proposals page: the agent it is filtered to. Malformed values are dropped. */
export const proposalsSearch = z.object({
	agent: z.string().min(1).max(64).optional().catch(undefined),
});

export interface ProposalGroup {
	issue: Issue;
	/** Oldest first, the order the issue page shows them in. */
	proposals: Proposal[];
}

/**
 * Open proposals grouped by issue, the issue touched most recently first. Proposals of issues
 * the replica does not hold are left out (the server drops them with their issue), and so are
 * proposals of other agents when `agentId` is set.
 */
export function groupProposals(
	proposals: Iterable<Proposal>,
	issues: ReadonlyMap<string, Issue>,
	agentId?: string,
): ProposalGroup[] {
	const groups = new Map<string, ProposalGroup>();
	for (const proposal of proposals) {
		if (agentId && proposal.agentId !== agentId) continue;
		const issue = issues.get(proposal.issueId);
		if (!issue) continue;
		const group = groups.get(issue.id);
		if (group) group.proposals.push(proposal);
		else groups.set(issue.id, { issue, proposals: [proposal] });
	}
	for (const group of groups.values()) {
		group.proposals.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}
	// The id breaks ties so every client orders the page the same way.
	return [...groups.values()].sort(
		(a, b) => b.issue.updatedAt - a.issue.updatedAt || a.issue.id.localeCompare(b.issue.id),
	);
}

/** The agents with at least one of these proposals, in the order of their first appearance. */
export function proposingAgents(proposals: Iterable<Proposal>): string[] {
	return [...new Set([...proposals].map((proposal) => proposal.agentId))];
}
