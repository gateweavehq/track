import {
	CLOSED_STATUSES,
	type Issue,
	type IssueRelation,
	type RelationKind,
	relationOf,
} from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { type ReactElement, useId, useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { issueKey } from "#/lib/issues";
import { send, useUpdateIssue } from "#/lib/mutations";
import { useIssueRelations, useIssuesById, useTeamsById } from "#/lib/queries";
import { groupRelations, RELATION_META } from "#/lib/relations";
import { RelationPicker } from "./issue-picker";
import { StatusIcon } from "./meta";

/**
 * How an issue relates to others: what blocks it, what it blocks, duplicates and related issues,
 * in any team. An open issue marked as a duplicate offers to close it.
 */
export function Relations({ issue }: { issue: Issue }) {
	const client = useSyncClient();
	const update = useUpdateIssue();
	const relations = useIssueRelations(issue.id);
	const issues = useIssuesById();
	const [picking, setPicking] = useState(false);
	const headingId = useId();
	const groups = useMemo(
		() => groupRelations(relations, issue.id, issues),
		[relations, issue.id, issues],
	);
	const duplicate = groups.some((group) => group.kind === "duplicate_of");

	function relate(kind: RelationKind, otherId: string) {
		send(client, {
			name: "relation.create",
			args: { id: uuidv7(), ...relationOf(kind, issue.id, otherId) },
		});
	}

	function remove(relation: IssueRelation) {
		send(client, { name: "relation.delete", args: { id: relation.id } });
	}

	const picker = (trigger: ReactElement, align?: "start" | "end") => (
		<RelationPicker
			issue={issue}
			onPick={relate}
			open={picking}
			onOpenChange={setPicking}
			align={align}
		>
			{trigger}
		</RelationPicker>
	);

	if (groups.length === 0) {
		return picker(
			<Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
				<Plus />
				Add relation
			</Button>,
		);
	}

	return (
		<section aria-labelledby="relations-heading" className="space-y-2">
			<div className="flex items-center gap-2">
				<h2 id="relations-heading" className="text-sm font-medium">
					Relations
				</h2>
				{duplicate && !CLOSED_STATUSES.includes(issue.status) && (
					<Button
						variant="outline"
						size="sm"
						className="h-7"
						onClick={() => update(issue, { status: "canceled" })}
					>
						Close as duplicate
					</Button>
				)}
				{picker(
					<Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="Add relation">
						<Plus />
					</Button>,
					"end",
				)}
			</div>
			<div className="divide-y rounded-lg border">
				{groups.map(({ kind, items }) => {
					const { label, icon: Icon } = RELATION_META[kind];
					return (
						<div key={kind}>
							<h3
								id={`${headingId}-${kind}`}
								className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-xs text-muted-foreground"
							>
								<Icon aria-hidden className="size-3.5" />
								{label}
							</h3>
							<ul aria-labelledby={`${headingId}-${kind}`}>
								{items.map(({ relation, issue: other }) => (
									<RelationRow key={relation.id} issue={other} onRemove={() => remove(relation)} />
								))}
							</ul>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function RelationRow({ issue, onRemove }: { issue: Issue; onRemove: () => void }) {
	const { slug } = useWorkspace();
	const team = useTeamsById().get(issue.teamId);
	const key = issueKey(team, issue);

	return (
		<li className="relative flex h-9 items-center gap-2 px-2 text-sm hover:bg-accent/40">
			<StatusIcon status={issue.status} />
			<span aria-hidden className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
				{key}
			</span>
			<Link
				to="/$workspace/issue/$issueKey"
				params={{ workspace: slug, issueKey: key }}
				className="min-w-0 flex-1 truncate outline-none after:absolute after:inset-0 focus-visible:underline"
			>
				<span className="sr-only">{key} </span>
				{issue.title}
			</Link>
			<Button
				variant="ghost"
				size="icon"
				className="relative size-7 text-muted-foreground"
				aria-label={`Remove relation to ${key}`}
				onClick={onRemove}
			>
				<X />
			</Button>
		</li>
	);
}
