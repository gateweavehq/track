import type { Issue, Member, Team } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { forwardRef, memo, type ReactNode } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { useWorkspace } from "#/components/workspace/context";
import { formatDateTime, formatShortDate } from "#/lib/dates";
import { issueKey } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";
import type { ProjectProgress } from "#/lib/projects";
import { cn } from "#/lib/utils";
import { BlockedMark } from "./blocked-mark";
import { useDraggableIssue } from "./dnd";
import { DropIndicator } from "./drop-indicator";
import { LabelChips } from "./labels";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";
import { AssigneePicker, PriorityPicker, StatusPicker } from "./pickers";
import { DueDate, Estimate } from "./schedule";
import { SubIssueCount } from "./sub-issue-count";

export type IssueField =
	| "status"
	| "priority"
	| "assignee"
	| "project"
	| "cycle"
	| "parent"
	| "labels"
	| "estimate";

interface IssueRowProps {
	issue: Issue;
	team: Team | undefined;
	assignee: Member | undefined;
	/** Its sub-issues' progress, if it has any. */
	subIssues: ProjectProgress | undefined;
	/** Whether an open issue blocks it. */
	blocked: boolean;
	selected: boolean;
	/** The property menu open on this row, if any. */
	menu: IssueField | null;
	onMenuChange: (issueId: string, menu: IssueField | null) => void;
	onSelect: (issueId: string) => void;
	registerRow: (issueId: string, link: HTMLAnchorElement | null) => void;
}

/**
 * One issue in a list. The title link stretches over the whole row, so the row opens the issue
 * from anywhere, while the property buttons sit above it and open their menus instead. Rows can
 * be dragged to reorder them or to move them to another status.
 */
export const IssueRow = memo(function IssueRow({
	issue,
	team,
	assignee,
	subIssues,
	blocked,
	selected,
	menu,
	onMenuChange,
	onSelect,
	registerRow,
}: IssueRowProps) {
	const { slug } = useWorkspace();
	const update = useUpdateIssue();
	const key = issueKey(team, issue);
	const [rowRef, drag] = useDraggableIssue<HTMLDivElement>(issue.id);
	const menuProps = (field: IssueField) => ({
		open: menu === field,
		onOpenChange: (open: boolean) => onMenuChange(issue.id, open ? field : null),
	});

	return (
		<div
			ref={rowRef}
			data-selected={selected}
			className={cn(
				"relative flex h-10 items-center gap-2 border-b px-3 text-sm last:border-b-0 hover:bg-accent/40 data-[selected=true]:bg-accent sm:px-4",
				drag.dragging && "opacity-40",
			)}
		>
			{drag.edge && <DropIndicator edge={drag.edge} />}
			<PriorityPicker
				value={issue.priority}
				onChange={(priority) => update(issue, { priority })}
				{...menuProps("priority")}
			>
				<RowButton label={`Priority: ${PRIORITY_META[issue.priority].label}`}>
					<PriorityIcon priority={issue.priority} />
				</RowButton>
			</PriorityPicker>
			<span
				aria-hidden
				className="hidden w-16 shrink-0 font-mono text-xs text-muted-foreground tabular-nums sm:block"
			>
				{key}
			</span>
			<StatusPicker
				value={issue.status}
				onChange={(status) => update(issue, { status })}
				{...menuProps("status")}
			>
				<RowButton label={`Status: ${STATUS_META[issue.status].label}`}>
					<StatusIcon status={issue.status} />
				</RowButton>
			</StatusPicker>
			<Link
				ref={(link) => registerRow(issue.id, link)}
				to="/$workspace/issue/$issueKey"
				params={{ workspace: slug, issueKey: key }}
				onFocus={() => onSelect(issue.id)}
				draggable={false}
				className="min-w-0 flex-1 truncate outline-none after:absolute after:inset-0"
			>
				<span className="sr-only">{key} </span>
				{issue.title}
			</Link>
			<LabelChips labelIds={issue.labelIds} max={2} className="hidden shrink-0 lg:flex" />
			<BlockedMark blocked={blocked} />
			<SubIssueCount progress={subIssues} className="hidden sm:inline-flex" />
			<Estimate estimate={issue.estimate} className="hidden sm:inline-flex" />
			<DueDate issue={issue} />
			<time
				dateTime={new Date(issue.createdAt).toISOString()}
				title={`Created ${formatDateTime(issue.createdAt)}`}
				className="hidden shrink-0 text-xs text-muted-foreground md:block"
			>
				{formatShortDate(issue.createdAt)}
			</time>
			<AssigneePicker
				value={issue.assigneeId}
				onChange={(assigneeId) => update(issue, { assigneeId })}
				{...menuProps("assignee")}
			>
				<RowButton label={assignee ? `Assignee: ${assignee.name}` : "Assign"}>
					<MemberAvatar member={assignee} />
				</RowButton>
			</AssigneePicker>
		</div>
	);
});

/** A small icon button that opens a property menu, kept above a row's or card's stretched link. */
export const RowButton = forwardRef<HTMLButtonElement, { label: string; children: ReactNode }>(
	function RowButton({ label, children, ...props }, ref) {
		return (
			<button
				ref={ref}
				type="button"
				aria-label={label}
				title={label}
				className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				{...props}
			>
				{children}
			</button>
		);
	},
);
