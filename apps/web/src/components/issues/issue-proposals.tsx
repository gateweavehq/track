import type { Issue, Label, Proposal } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Bot } from "lucide-react";
import { type ReactNode, useId } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { send } from "#/lib/mutations";
import { useIssueProposals, useLabelsById, useMembersById } from "#/lib/queries";
import { LabelChip } from "./labels";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";

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

function ProposalItem({ proposal }: { proposal: Proposal }) {
	const client = useSyncClient();
	const members = useMembersById();
	const labels = useLabelsById();
	const textId = useId();
	const agent = members.get(proposal.agentId);
	const name = (id: string | null) => (id ? (members.get(id)?.name ?? "someone") : "nobody");
	const decide = (mutation: "proposal.accept" | "proposal.dismiss") =>
		send(client, { name: mutation, args: { id: proposal.id } });

	return (
		<li className="flex flex-col gap-2 sm:flex-row sm:items-start">
			<div className="flex min-w-0 flex-1 items-start gap-2 text-sm">
				<MemberAvatar member={agent} className="mt-0.5 size-5" />
				<div id={textId} className="min-w-0 flex-1 leading-6">
					<span className="font-medium">{agent?.name ?? "An agent"}</span>{" "}
					{describe(proposal.change, name, labels)}
					<span aria-hidden className="text-muted-foreground">
						{" "}
						·{" "}
					</span>
					<time
						dateTime={new Date(proposal.updatedAt).toISOString()}
						title={formatDateTime(proposal.updatedAt)}
						className="text-xs text-muted-foreground"
					>
						{formatRelative(proposal.updatedAt)}
					</time>
				</div>
			</div>
			<div className="flex shrink-0 gap-2 pl-7 sm:pl-0">
				<Button
					variant="ghost"
					size="sm"
					aria-describedby={textId}
					onClick={() => decide("proposal.dismiss")}
				>
					Dismiss
				</Button>
				<Button
					variant="outline"
					size="sm"
					aria-describedby={textId}
					onClick={() => decide("proposal.accept")}
				>
					Accept
				</Button>
			</div>
		</li>
	);
}

function describe(
	change: Proposal["change"],
	name: (id: string | null) => string,
	labels: ReadonlyMap<string, Label>,
): ReactNode {
	switch (change.type) {
		case "status":
			return (
				<>
					proposes moving it to{" "}
					<span className="inline-flex items-center gap-1 align-middle font-medium">
						<StatusIcon status={change.to} className="size-3.5" />
						{STATUS_META[change.to].label}
					</span>
				</>
			);
		case "priority":
			if (change.to === 0) return "proposes removing the priority";
			return (
				<>
					proposes the priority{" "}
					<span className="inline-flex items-center gap-1 align-middle font-medium">
						<PriorityIcon priority={change.to} className="size-3.5" />
						{PRIORITY_META[change.to].label}
					</span>
				</>
			);
		case "assignee":
			if (change.to === null) return "proposes unassigning it";
			return (
				<>
					proposes assigning <span className="font-medium">{name(change.to)}</span>
				</>
			);
		case "title":
			return (
				<>
					proposes renaming it to <span className="font-medium">“{change.to}”</span>
				</>
			);
		case "description":
			if (change.to === null) return "proposes clearing the description";
			return (
				<>
					proposes a new description
					<details className="mt-1">
						<summary className="cursor-pointer text-xs text-muted-foreground">Show it</summary>
						<p className="mt-1 rounded-md border bg-background p-2 text-sm break-words whitespace-pre-wrap">
							{change.to}
						</p>
					</details>
				</>
			);
		case "label": {
			const found = labels.get(change.labelId);
			return (
				<span className="inline-flex flex-wrap items-center gap-1 align-middle">
					{change.added ? "proposes adding" : "proposes removing"}{" "}
					{found ? <LabelChip label={found} /> : "a deleted label"}
				</span>
			);
		}
	}
}
