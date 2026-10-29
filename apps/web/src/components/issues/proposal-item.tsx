import type { Label, Proposal } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { send } from "#/lib/mutations";
import { useLabelsById, useMembersById, useProjectsById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { LabelChip } from "./labels";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";

export type ProposalDecision = "proposal.accept" | "proposal.dismiss";

/**
 * One change an agent proposed, with the buttons to accept or dismiss it. It is shown on the
 * issue page and in the workspace's list of proposals. The list passes the selection props so the
 * keyboard can move between rows; the issue page leaves them out.
 */
export function ProposalItem({
	proposal,
	selected,
	onSelect,
	onOpen,
	registerItem,
}: {
	proposal: Proposal;
	selected?: boolean;
	onSelect?: (proposalId: string) => void;
	/** Enter on the focused row. */
	onOpen?: (proposal: Proposal) => void;
	registerItem?: (proposalId: string, element: HTMLLIElement | null) => void;
}) {
	const client = useSyncClient();
	const members = useMembersById();
	const labels = useLabelsById();
	const projects = useProjectsById();
	const textId = useId();
	const agent = members.get(proposal.agentId);
	const name = (id: string | null) => (id ? (members.get(id)?.name ?? "someone") : "nobody");
	const decide = (mutation: ProposalDecision) =>
		send(client, { name: mutation, args: { id: proposal.id } });

	function onKeyDown(event: KeyboardEvent<HTMLLIElement>) {
		// Only when the row itself has focus: Enter on a button must press the button.
		if (event.key === "Enter" && event.target === event.currentTarget) {
			event.preventDefault();
			onOpen?.(proposal);
		}
	}

	return (
		<li
			ref={registerItem ? (element) => registerItem(proposal.id, element) : undefined}
			tabIndex={registerItem ? -1 : undefined}
			data-selected={selected}
			onFocus={onSelect ? () => onSelect(proposal.id) : undefined}
			onKeyDown={onOpen ? onKeyDown : undefined}
			className={cn(
				"flex flex-col gap-2 sm:flex-row sm:items-start",
				registerItem && "rounded-md px-2 py-1.5 outline-none data-[selected=true]:bg-accent",
			)}
		>
			<div className="flex min-w-0 flex-1 items-start gap-2 text-sm">
				<MemberAvatar member={agent} className="mt-0.5 size-5" />
				<div id={textId} className="min-w-0 flex-1 leading-6">
					<span className="font-medium">{agent?.name ?? "An agent"}</span>{" "}
					{describe(
						proposal.change,
						name,
						labels,
						(id) => projects.get(id)?.name ?? "a deleted project",
					)}
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
	projectName: (id: string) => string,
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
		case "project":
			if (change.to === null) return "proposes taking it out of its project";
			return (
				<>
					proposes adding it to <span className="font-medium">{projectName(change.to)}</span>
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
