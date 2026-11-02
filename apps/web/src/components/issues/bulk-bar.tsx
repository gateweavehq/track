import type { Issue } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Archive, CircleDashed, Layers, Tag, Trash2, UserRound, X } from "lucide-react";
import { forwardRef, type ReactNode, useState } from "react";
import { CycleIcon } from "#/components/cycles/meta";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { type IssuePatch, send, useUpdateIssue } from "#/lib/mutations";
import { useStatuses } from "#/lib/queries";
import { isIssueClosed } from "#/lib/statuses";
import { LabelMenu } from "./labels";
import { PriorityIcon } from "./meta";
import {
	AssigneePicker,
	CyclePicker,
	PriorityPicker,
	ProjectPicker,
	StatusPicker,
} from "./pickers";
import type { useIssueSelection } from "./selection";

/** A property menu the bar can open from the keyboard, as a list opens a row's. */
export type BulkField = "status" | "priority" | "assignee";

/**
 * Changes several issues at once: the selected issues in a list. Each change goes out as one
 * mutation per issue that needs it, the same mutations a single issue's menus send, so the server
 * checks, stamps and tells of each as it would one at a time.
 */
export function BulkBar({
	selection,
	total,
}: {
	selection: ReturnType<typeof useIssueSelection>;
	/** How many issues are shown, to offer picking them all. */
	total: number;
}) {
	const {
		checked: issues,
		menu,
		setMenu: onMenuChange,
		selectAll: onSelectAll,
		clear: onClear,
	} = selection;
	const client = useSyncClient();
	const update = useUpdateIssue();
	const statuses = useStatuses();
	const [confirmDelete, setConfirmDelete] = useState(false);
	const first = issues[0];
	if (!first) return null;

	/** The value every selected issue shares, or the first one's with `mixed` when they differ. */
	const common = <V,>(read: (issue: Issue) => V) => {
		const value = read(first);
		return { value, mixed: issues.some((issue) => read(issue) !== value) };
	};
	const apply = (patch: (issue: Issue) => IssuePatch | null) => {
		for (const issue of issues) {
			const changes = patch(issue);
			if (changes) update(issue, changes);
		}
	};
	const menuProps = (field: BulkField) => ({
		open: menu === field,
		onOpenChange: (open: boolean) => onMenuChange(open ? field : null),
	});
	// Statuses and cycles belong to a team, so they are offered only for issues of one team.
	const oneTeam = issues.every((issue) => issue.teamId === first.teamId);
	const shared = first.labelIds.filter((labelId) =>
		issues.every((issue) => issue.labelIds.includes(labelId)),
	);
	const count = issues.length === 1 ? "1 issue" : `${issues.length} issues`;
	// Only closed issues are archived; the open ones among them stay as they are.
	const closed = issues.filter(
		(issue) => issue.archivedAt === null && isIssueClosed(statuses, issue),
	);
	const archive =
		closed.length === 1 ? "Archive 1 closed issue" : `Archive ${closed.length} closed issues`;

	return (
		<section
			aria-label="Selected issues"
			className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-1 overflow-x-auto rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-lg"
		>
			<span className="shrink-0 px-2 text-sm font-medium tabular-nums">{count} selected</span>
			{issues.length < total && (
				<Button variant="ghost" size="sm" className="shrink-0" onClick={onSelectAll}>
					Select all {total}
				</Button>
			)}
			<span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
			{oneTeam && (
				<StatusPicker
					teamId={first.teamId}
					{...common((issue) => issue.status)}
					onChange={(status) => apply((issue) => (issue.status === status ? null : { status }))}
					{...menuProps("status")}
				>
					<BarButton icon={<CircleDashed />}>Status</BarButton>
				</StatusPicker>
			)}
			<PriorityPicker
				{...common((issue) => issue.priority)}
				onChange={(priority) =>
					apply((issue) => (issue.priority === priority ? null : { priority }))
				}
				{...menuProps("priority")}
			>
				<BarButton icon={<PriorityIcon priority={first.priority} />}>Priority</BarButton>
			</PriorityPicker>
			<AssigneePicker
				{...common((issue) => issue.assigneeId)}
				onChange={(assigneeId) =>
					apply((issue) => (issue.assigneeId === assigneeId ? null : { assigneeId }))
				}
				{...menuProps("assignee")}
			>
				<BarButton icon={<UserRound />}>Assignee</BarButton>
			</AssigneePicker>
			<LabelMenu
				selected={shared}
				creatable
				onToggle={(labelId) => {
					// A label they all have comes off all of them; otherwise it goes on those without it.
					const remove = shared.includes(labelId);
					for (const issue of issues) {
						if (issue.labelIds.includes(labelId) !== remove) continue;
						send(client, {
							name: remove ? "issue.removeLabel" : "issue.addLabel",
							args: { id: issue.id, labelId },
						});
					}
				}}
			>
				<BarButton icon={<Tag />}>Labels</BarButton>
			</LabelMenu>
			<ProjectPicker
				{...common((issue) => issue.projectId)}
				onChange={(projectId) =>
					apply((issue) => (issue.projectId === projectId ? null : { projectId }))
				}
			>
				<BarButton icon={<Layers />}>Project</BarButton>
			</ProjectPicker>
			{oneTeam && (
				<CyclePicker
					teamId={first.teamId}
					{...common((issue) => issue.cycleId)}
					onChange={(cycleId) => apply((issue) => (issue.cycleId === cycleId ? null : { cycleId }))}
				>
					<BarButton icon={<CycleIcon />}>Cycle</BarButton>
				</CyclePicker>
			)}
			<span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
			{closed.length > 0 && (
				<Button
					variant="ghost"
					size="icon"
					className="size-8 shrink-0"
					aria-label={archive}
					title={archive}
					onClick={() => {
						for (const issue of closed) {
							send(client, { name: "issue.archive", args: { id: issue.id, archived: true } });
						}
					}}
				>
					<Archive />
				</Button>
			)}
			<Button
				variant="ghost"
				size="icon"
				className="size-8 shrink-0 text-destructive hover:text-destructive"
				aria-label={`Delete ${count}`}
				title={`Delete ${count}`}
				onClick={() => setConfirmDelete(true)}
			>
				<Trash2 />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				className="size-8 shrink-0"
				aria-label="Clear selection"
				title="Clear selection (Esc)"
				onClick={onClear}
			>
				<X />
			</Button>
			{confirmDelete && (
				<ConfirmDialog
					title={`Delete ${count}?`}
					confirmLabel="Delete"
					onClose={() => setConfirmDelete(false)}
					onConfirm={() => {
						for (const issue of issues) {
							send(client, { name: "issue.delete", args: { id: issue.id } });
						}
						setConfirmDelete(false);
						onClear();
					}}
				>
					They are deleted for everyone in the workspace, with their comments. Their sub-issues
					stay, as issues of their own.
				</ConfirmDialog>
			)}
		</section>
	);
}

/** A menu's button: its icon, and its name beside it where there is room. */
const BarButton = forwardRef<HTMLButtonElement, { icon: ReactNode; children: string }>(
	function BarButton({ icon, children, ...props }, ref) {
		return (
			<Button
				ref={ref}
				variant="ghost"
				size="sm"
				aria-label={children}
				title={children}
				className="shrink-0 gap-1.5 [&_svg]:size-4 [&_svg]:text-muted-foreground"
				{...props}
			>
				{icon}
				<span className="hidden sm:inline">{children}</span>
			</Button>
		);
	},
);
