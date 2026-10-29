import type { Proposal } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useHotkeys } from "#/lib/hotkeys";
import { issueKey } from "#/lib/issues";
import { send } from "#/lib/mutations";
import { groupProposals, proposingAgents } from "#/lib/proposals";
import { useIssuesById, useMembersById, useProposals, useTeamsById } from "#/lib/queries";
import { ProposalItem } from "./proposal-item";

/**
 * Every open proposal of the workspace, grouped by issue. J/K or the arrow keys move between
 * proposals, A accepts the selected one, D dismisses it and Enter opens its issue.
 */
export function ProposalsPage({
	agentFilter,
	onAgentFilterChange,
}: {
	/** Show only this agent's proposals. An id with no open proposals is ignored. */
	agentFilter: string | undefined;
	onAgentFilterChange: (agentId: string | undefined) => void;
}) {
	const { slug } = useWorkspace();
	const client = useSyncClient();
	const navigate = useNavigate();
	const proposals = useProposals();
	const issues = useIssuesById();
	const teams = useTeamsById();
	const members = useMembersById();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const items = useRef(new Map<string, HTMLLIElement>());

	const agents = useMemo(() => proposingAgents(proposals.values()), [proposals]);
	const activeAgent = agentFilter && agents.includes(agentFilter) ? agentFilter : undefined;
	const groups = useMemo(
		() => groupProposals(proposals.values(), issues, activeAgent),
		[proposals, issues, activeAgent],
	);
	const flat = groups.flatMap((group) => group.proposals);

	const registerItem = useCallback((id: string, element: HTMLLIElement | null) => {
		if (element) items.current.set(id, element);
		else items.current.delete(id);
	}, []);

	function select(step: 1 | -1) {
		const index = flat.findIndex((proposal) => proposal.id === selectedId);
		const next = index === -1 ? flat[step === 1 ? 0 : flat.length - 1] : flat[index + step];
		// Focusing the row selects it (onFocus) and scrolls it into view.
		if (next) items.current.get(next.id)?.focus();
	}

	function open(proposal: Proposal) {
		const issue = issues.get(proposal.issueId);
		if (!issue) return;
		void navigate({
			to: "/$workspace/issue/$issueKey",
			params: { workspace: slug, issueKey: issueKey(teams.get(issue.teamId), issue) },
		});
	}

	function decide(mutation: "proposal.accept" | "proposal.dismiss") {
		const index = flat.findIndex((proposal) => proposal.id === selectedId);
		const proposal = flat[index];
		if (!proposal) return;
		if (!send(client, { name: mutation, args: { id: proposal.id } })) return;
		// The row disappears, which drops its focus; carry the selection on to its neighbour.
		const neighbour = flat[index + 1] ?? flat[index - 1];
		if (neighbour) requestAnimationFrame(() => items.current.get(neighbour.id)?.focus());
	}

	const next = () => select(1);
	const previous = () => select(-1);
	useHotkeys({
		j: next,
		ArrowDown: next,
		k: previous,
		ArrowUp: previous,
		a: () => decide("proposal.accept"),
		d: () => decide("proposal.dismiss"),
	});

	const agentName = (id: string) => members.get(id)?.name ?? "An agent";

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<h1 className="truncate text-sm font-medium">Proposals</h1>
				<span className="text-sm text-muted-foreground tabular-nums">{flat.length}</span>
				{agents.length > 0 && (
					<div className="ml-auto">
						<select
							aria-label="Filter by agent"
							value={activeAgent ?? ""}
							onChange={(event) => onAgentFilterChange(event.target.value || undefined)}
							className="h-8 max-w-48 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<option value="">All agents</option>
							{agents.map((id) => (
								<option key={id} value={id}>
									{agentName(id)}
								</option>
							))}
						</select>
					</div>
				)}
			</header>
			{groups.length === 0 ? (
				<Notice title="Nothing to decide">
					Changes your agents propose instead of making show up here, for you to accept or dismiss.
				</Notice>
			) : (
				<div className="space-y-6 p-3 sm:p-4">
					{groups.map(({ issue, proposals: group }) => {
						const key = issueKey(teams.get(issue.teamId), issue);
						return (
							<section key={issue.id} aria-label={`Proposals for ${key}`} className="space-y-1">
								<h2 className="flex min-w-0 items-baseline gap-2 px-2 text-sm">
									<Link
										to="/$workspace/issue/$issueKey"
										params={{ workspace: slug, issueKey: key }}
										className="flex min-w-0 items-baseline gap-2 hover:underline"
									>
										<span className="shrink-0 font-mono text-xs text-muted-foreground">{key}</span>
										<span className="truncate font-medium">{issue.title}</span>
									</Link>
								</h2>
								<ul>
									{group.map((proposal) => (
										<ProposalItem
											key={proposal.id}
											proposal={proposal}
											selected={proposal.id === selectedId}
											onSelect={setSelectedId}
											onOpen={open}
											registerItem={registerItem}
										/>
									))}
								</ul>
							</section>
						);
					})}
				</div>
			)}
		</div>
	);
}
