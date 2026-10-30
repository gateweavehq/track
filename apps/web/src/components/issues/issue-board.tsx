import type { Issue, Member, Team } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { memo, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	type IssueDefaults,
	useWorkspace,
	useWorkspaceActions,
} from "#/components/workspace/context";
import { useHotkeys } from "#/lib/hotkeys";
import { BOARD_STATUS_ORDER, groupByStatus, issueKey, type StatusGroup } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";
import type { ProjectProgress } from "#/lib/projects";
import {
	useBlockedIssueIds,
	useMembersById,
	useSubIssueProgress,
	useTeamsById,
} from "#/lib/queries";
import { cn } from "#/lib/utils";
import { BlockedMark } from "./blocked-mark";
import { useDragAutoScroll, useDraggableIssue, useIssueDropZone, useIssueMoves } from "./dnd";
import { DropIndicator } from "./drop-indicator";
import { type IssueField, RowButton } from "./issue-row";
import { LabelChips } from "./labels";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";
import { AssigneePicker, PriorityPicker, StatusPicker } from "./pickers";
import { DueDate, Estimate } from "./schedule";
import { SubIssueCount } from "./sub-issue-count";

/** The space between cards, in pixels. Drop indicators sit in the middle of it. */
const CARD_GAP = 8;

/**
 * Issues in one column per status. Cards are dragged within and between columns. From the
 * keyboard, J/K and H/L (or the arrow keys) move the selection, Alt with the arrow keys moves the
 * selected card, and S, P and A change its status, priority and assignee.
 */
export function IssueBoard({
	issues,
	defaults,
	empty,
}: {
	issues: Issue[];
	/** Values for issues created from this board, such as its team. */
	defaults: IssueDefaults;
	/** Shown when there are no issues at all. */
	empty: ReactNode;
}) {
	const teams = useTeamsById();
	const members = useMembersById();
	const subIssues = useSubIssueProgress();
	const blocked = useBlockedIssueIds();
	const columns = useMemo(() => groupByStatus(issues, BOARD_STATUS_ORDER), [issues]);
	const moveIssue = useIssueMoves(columns);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ issueId: string; field: IssueField } | null>(null);
	const cards = useRef(new Map<string, HTMLAnchorElement>());
	const scrollerRef = useRef<HTMLDivElement>(null);
	useDragAutoScroll(scrollerRef, issues.length > 0);

	const registerCard = useCallback((issueId: string, link: HTMLAnchorElement | null) => {
		if (link) cards.current.set(issueId, link);
		else cards.current.delete(issueId);
	}, []);
	const onMenuChange = useCallback((issueId: string, field: IssueField | null) => {
		setMenu(field ? { issueId, field } : null);
	}, []);

	/** The selected card's column and row, if it is on the board. */
	function position() {
		for (const [column, group] of columns.entries()) {
			const row = group.issues.findIndex((issue) => issue.id === selectedId);
			if (row !== -1) return { column, row };
		}
		return null;
	}

	const focusCard = (issueId: string) => cards.current.get(issueId)?.focus();

	function selectVertical(step: 1 | -1) {
		const at = position();
		if (!at) {
			const first = columns.find((group) => group.issues.length > 0)?.issues[0];
			if (first) focusCard(first.id);
			return;
		}
		const next = columns[at.column]?.issues[at.row + step];
		if (next) focusCard(next.id);
	}

	function selectHorizontal(step: 1 | -1) {
		const at = position();
		if (!at) {
			selectVertical(1);
			return;
		}
		// Skip empty columns, and keep the row as far as the next column allows.
		for (let column = at.column + step; column >= 0 && column < columns.length; column += step) {
			const target = columns[column]?.issues ?? [];
			const next = target[Math.min(at.row, target.length - 1)];
			if (next) {
				focusCard(next.id);
				return;
			}
		}
	}

	function moveSelected(columnStep: -1 | 0 | 1, rowStep: -1 | 0 | 1) {
		const at = position();
		if (!at) return;
		const issue = columns[at.column]?.issues[at.row];
		const target = columns[at.column + columnStep];
		if (!issue || !target) return;
		// Within a column, positions count the other cards, so one step is index ± 1. Into
		// another column, the card keeps its row.
		const index = columnStep === 0 ? at.row + rowStep : at.row;
		if (moveIssue(issue, target.status, index)) {
			// Moving a card moves or remounts its element, which drops its focus.
			requestAnimationFrame(() => focusCard(issue.id));
		}
	}

	function openMenu(field: IssueField) {
		if (selectedId && position()) setMenu({ issueId: selectedId, field });
	}

	const down = () => selectVertical(1);
	const up = () => selectVertical(-1);
	const left = () => selectHorizontal(-1);
	const right = () => selectHorizontal(1);
	useHotkeys({
		j: down,
		ArrowDown: down,
		k: up,
		ArrowUp: up,
		h: left,
		ArrowLeft: left,
		l: right,
		ArrowRight: right,
		"alt+ArrowDown": () => moveSelected(0, 1),
		"alt+ArrowUp": () => moveSelected(0, -1),
		"alt+ArrowLeft": () => moveSelected(-1, 0),
		"alt+ArrowRight": () => moveSelected(1, 0),
		s: () => openMenu("status"),
		p: () => openMenu("priority"),
		a: () => openMenu("assignee"),
	});

	if (issues.length === 0) return empty;

	return (
		<div ref={scrollerRef} className="flex h-full gap-3 overflow-x-auto p-3">
			{columns.map((group) => (
				<BoardColumn key={group.status} group={group} defaults={defaults}>
					{group.issues.map((issue) => (
						<IssueCard
							key={issue.id}
							issue={issue}
							team={teams.get(issue.teamId)}
							assignee={issue.assigneeId ? members.get(issue.assigneeId) : undefined}
							subIssues={subIssues.get(issue.id)}
							blocked={blocked.has(issue.id)}
							selected={issue.id === selectedId}
							menu={menu?.issueId === issue.id ? menu.field : null}
							onMenuChange={onMenuChange}
							onSelect={setSelectedId}
							registerCard={registerCard}
						/>
					))}
				</BoardColumn>
			))}
		</div>
	);
}

/** A column of cards. Dropping an issue on the column, outside any card, puts it at the end. */
function BoardColumn({
	group,
	defaults,
	children,
}: {
	group: StatusGroup;
	defaults: IssueDefaults;
	children: ReactNode;
}) {
	const actions = useWorkspaceActions();
	const [ref, over] = useIssueDropZone<HTMLElement>(group.status, "end");
	const listRef = useRef<HTMLDivElement>(null);
	useDragAutoScroll(listRef);
	const label = STATUS_META[group.status].label;

	return (
		<section
			ref={ref}
			aria-label={label}
			className={cn(
				"flex w-72 shrink-0 flex-col rounded-lg bg-muted/50 transition-colors",
				over && "bg-accent",
			)}
		>
			<header className="flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3 text-sm">
				<StatusIcon status={group.status} />
				<h2 className="font-medium">{label}</h2>
				<span className="text-muted-foreground tabular-nums">{group.issues.length}</span>
				<Button
					variant="ghost"
					size="icon"
					className="ml-auto size-7"
					aria-label={`Create a ${label} issue`}
					onClick={() => actions.createIssue({ ...defaults, status: group.status })}
				>
					<Plus />
				</Button>
			</header>
			<div
				ref={listRef}
				style={{ gap: CARD_GAP }}
				className="flex min-h-16 flex-1 flex-col overflow-y-auto px-2 pb-2"
			>
				{children}
			</div>
		</section>
	);
}

interface IssueCardProps {
	issue: Issue;
	team: Team | undefined;
	assignee: Member | undefined;
	subIssues: ProjectProgress | undefined;
	blocked: boolean;
	selected: boolean;
	menu: IssueField | null;
	onMenuChange: (issueId: string, menu: IssueField | null) => void;
	onSelect: (issueId: string) => void;
	registerCard: (issueId: string, link: HTMLAnchorElement | null) => void;
}

/** One issue on the board. Like a list row, its title link covers the card. */
const IssueCard = memo(function IssueCard({
	issue,
	team,
	assignee,
	subIssues,
	blocked,
	selected,
	menu,
	onMenuChange,
	onSelect,
	registerCard,
}: IssueCardProps) {
	const { slug } = useWorkspace();
	const update = useUpdateIssue();
	const key = issueKey(team, issue);
	const [cardRef, drag] = useDraggableIssue<HTMLDivElement>(issue.id);
	const menuProps = (field: IssueField) => ({
		open: menu === field,
		onOpenChange: (open: boolean) => onMenuChange(issue.id, open ? field : null),
	});

	return (
		<div
			ref={cardRef}
			data-selected={selected}
			className={cn(
				"relative shrink-0 rounded-md border bg-card p-2 text-sm shadow-xs hover:border-foreground/20 data-[selected=true]:border-ring data-[selected=true]:ring-1 data-[selected=true]:ring-ring",
				drag.dragging && "opacity-40",
			)}
		>
			{drag.edge && <DropIndicator edge={drag.edge} gap={CARD_GAP} />}
			<div className="flex items-center gap-1">
				<StatusPicker
					value={issue.status}
					onChange={(status) => update(issue, { status })}
					{...menuProps("status")}
				>
					<RowButton label={`Status: ${STATUS_META[issue.status].label}`}>
						<StatusIcon status={issue.status} />
					</RowButton>
				</StatusPicker>
				<span aria-hidden className="font-mono text-xs text-muted-foreground tabular-nums">
					{key}
				</span>
				<div className="ml-auto">
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
			</div>
			<Link
				ref={(link) => registerCard(issue.id, link)}
				to="/$workspace/issue/$issueKey"
				params={{ workspace: slug, issueKey: key }}
				onFocus={() => onSelect(issue.id)}
				draggable={false}
				className="line-clamp-2 px-1.5 outline-none after:absolute after:inset-0"
			>
				<span className="sr-only">{key} </span>
				{issue.title}
			</Link>
			<div className="mt-1.5 flex min-w-0 items-center gap-1">
				<PriorityPicker
					value={issue.priority}
					onChange={(priority) => update(issue, { priority })}
					{...menuProps("priority")}
				>
					<RowButton label={`Priority: ${PRIORITY_META[issue.priority].label}`}>
						<PriorityIcon priority={issue.priority} />
					</RowButton>
				</PriorityPicker>
				<LabelChips labelIds={issue.labelIds} max={3} />
				<div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
					<BlockedMark blocked={blocked} />
					<SubIssueCount progress={subIssues} />
					<DueDate issue={issue} />
					<Estimate estimate={issue.estimate} />
				</div>
			</div>
		</div>
	);
});
