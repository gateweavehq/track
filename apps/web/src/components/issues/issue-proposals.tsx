import type { Issue } from "@gateweave/track-protocol";
import { Bot } from "lucide-react";
import { useIssueProposals } from "#/lib/queries";
import { ProposalItem } from "./proposal-item";

/**
 * Changes agents were set to propose rather than make. Accepting one makes it as you; the
 * issue's history then says whose idea it was.
 */
export function IssueProposals({ issue }: { issue: Issue }) {
	const proposals = useIssueProposals(issue.id);
	if (proposals.length === 0) return null;

	return (
		<section
			aria-labelledby="proposals-heading"
			className="space-y-3 rounded-lg border bg-muted/40 p-3"
		>
			<h2 id="proposals-heading" className="flex items-center gap-1.5 text-sm font-medium">
				<Bot aria-hidden className="size-4 text-muted-foreground" />
				Proposed by agents
			</h2>
			<ul className="space-y-2">
				{proposals.map((proposal) => (
					<ProposalItem key={proposal.id} proposal={proposal} />
				))}
			</ul>
		</section>
	);
}
