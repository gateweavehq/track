import type { Issue, IssueDisplay } from "@gateweave/track-protocol";
import { ChevronRight, Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { type IssueDefaults, useWorkspaceActions } from "#/components/workspace/context";
import { groupByOf, orderByOf, shownProperties } from "#/lib/display";
import { groupFields, groupIssues, type IssueGroup } from "#/lib/grouping";
import { useHotkeys } from "#/lib/hotkeys";
import {
	useBlockedIssueIds,
	useMembersById,
	useProjectsById,
	useStatuses,
	useSubIssueProgress,
	useTeamsById,
} from "#/lib/queries";
import { groupingTeams } from "#/lib/statuses";
import { markIssueListShown } from "#/lib/timing";
import { cn } from "#/lib/utils";
import { BulkBar, type BulkField } from "./bulk-bar";
import { useIssueDropZone, useIssueMoves } from "./dnd";
import { GroupIcon, useGroupName } from "./group-label";
import { type IssueField, IssueRow } from "./issue-row";
import { scrollParent, useItemsOnScreen } from "./rows-on-screen";
import { useIssueSelection } from "./selection";

/** Heights of the list's two kinds of entry, in pixels: `h-9` and `h-10`, borders included. */
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 40;

/**
 * One line of the list: a group's header or one of its issues. The list is one flat run of these,
 * so a row that changes group moves without remounting, and only the ones near the screen render.
 */
type ListEntry =
	| { kind: "header"; group: IssueGroup; collapsed: boolean }
	| { kind: "row"; group: IssueGroup; issue: Issue };

/**
 * Issues in groups (by status unless the display options say otherwise), driven from the keyboard:
 * J/K or the arrow keys move the selection, Enter opens the issue, S, P and A change the selected
 * issue's status, priority and assignee, and Alt with the arrow keys moves it up or down. Rows can
 * also be dragged.
 *
 * X picks the selected issue, as its checkbox does, and Shift extends from the last one picked.
 * While any are picked, a bar changes them all at once, S, P and A open its menus instead, and
 * Esc unpicks them.
 */
export function IssueList({
	issues,
	display,
	defaults,
	empty,
}: {
	issues: Issue[];
	/** How to group and order the issues, and which of their properties to show. */
	display: IssueDisplay;
	/** Values for issues created from this list, such as its team. */
	defaults: IssueDefaults;
	/** Shown when there are no issues at all. */
	empty: ReactNode;
}) {
	const teams = useTeamsById();
	const members = useMembersById();
	const subIssues = useSubIssueProgress();
	const blocked = useBlockedIssueIds();
	const projects = useProjectsById();
	const groupBy = groupByOf(display);
	const orderBy = orderByOf(display);
	const properties = useMemo(() => shownProperties(display), [display]);
	const statuses = useStatuses();
	const teamIds = useMemo(
		() => groupingTeams(issues, teams, defaults.teamId),
		[issues, teams, defaults.teamId],
	);
	const allGroups = useMemo(
		() => groupIssues(issues, groupBy, orderBy, "list", { members, projects, statuses, teamIds }),
		[issues, groupBy, orderBy, members, projects, statuses, teamIds],
	);
	const groups = useMemo(() => allGroups.filter((group) => group.issues.length > 0), [allGroups]);
	const moveIssue = useIssueMoves(allGroups, orderBy === "manual");
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ issueId: string; field: IssueField } | null>(null);
	const rows = useRef(new Map<string, HTMLAnchorElement>());
	const root = useRef<HTMLDivElement>(null);
	// An issue to focus once it has been scrolled to and rendered; see focusIssue.
	const pendingFocus = useRef<string | null>(null);

	const shown = groups.length > 0;
	useEffect(() => {
		if (shown) markIssueListShown(issues.length);
	}, [shown, issues.length]);

	const visible = groups.flatMap((group) => (collapsed.has(group.key) ? [] : group.issues));
	const entries = useMemo<ListEntry[]>(
		() =>
			groups.flatMap((group) => {
				const isCollapsed = collapsed.has(group.key);
				// Without grouping there is one group, and no header to put above it.
				const header: ListEntry[] =
					group.by === "none" ? [] : [{ kind: "header", group, collapsed: isCollapsed }];
				if (isCollapsed) return header;
				return [
					...header,
					...group.issues.map((issue) => ({ kind: "row" as const, group, issue })),
				];
			}),
		[groups, collapsed],
	);
	const offsets = useMemo(() => {
		const starts = [0];
		for (const entry of entries) {
			starts.push(
				(starts[starts.length - 1] ?? 0) + (entry.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
			);
		}
		return starts;
	}, [entries]);
	const entryOf = useMemo(() => {
		const indexes = new Map<string, number>();
		entries.forEach((entry, index) => {
			if (entry.kind === "row") indexes.set(entry.issue.id, index);
		});
		return indexes;
	}, [entries]);
	const [first, last] = useItemsOnScreen(offsets, root);
	// Keep the header of the group the first rendered row belongs to, so it can stick.
	let start = first;
	while (start > 0 && entries[start]?.kind === "row") start--;
	if (entries[start]?.kind !== "header") start = first;
	// Collapsing a group hides its issues without unpicking them.
	const selection = useIssueSelection(visible, issues);
	const { checkedIds, checking, onCheck } = selection;

	const registerRow = useCallback((issueId: string, link: HTMLAnchorElement | null) => {
		if (link) rows.current.set(issueId, link);
		else rows.current.delete(issueId);
	}, []);
	const onMenuChange = useCallback((issueId: string, field: IssueField | null) => {
		setMenu(field ? { issueId, field } : null);
	}, []);

	/**
	 * Focuses an issue's row, which selects it (onFocus). A row that is not rendered yet is scrolled
	 * to first, and focused once it renders.
	 */
	function focusIssue(issueId: string) {
		const link = rows.current.get(issueId);
		if (link) {
			link.focus();
			return;
		}
		const index = entryOf.get(issueId);
		const element = root.current;
		if (index === undefined || !element) return;
		pendingFocus.current = issueId;
		revealEntry(element, offsets[index] ?? 0);
	}

	// Runs after every render, which is when a scrolled-to row first appears.
	useEffect(() => {
		const issueId = pendingFocus.current;
		const link = issueId ? rows.current.get(issueId) : undefined;
		if (link) {
			pendingFocus.current = null;
			link.focus();
		}
	});

	function select(step: 1 | -1) {
		const index = visible.findIndex((issue) => issue.id === selectedId);
		const next =
			index === -1 ? visible[step === 1 ? 0 : visible.length - 1] : visible[index + step];
		if (next) focusIssue(next.id);
	}

	function openMenu(field: BulkField) {
		if (checking) {
			selection.openMenu(field);
			return;
		}
		if (selectedId && visible.some((issue) => issue.id === selectedId)) {
			setMenu({ issueId: selectedId, field });
		}
	}

	function moveSelected(step: 1 | -1) {
		const group = groups.find((candidate) =>
			candidate.issues.some((issue) => issue.id === selectedId),
		);
		const index = group?.issues.findIndex((issue) => issue.id === selectedId) ?? -1;
		const issue = group?.issues[index];
		if (!group || !issue || collapsed.has(group.key)) return;
		// Positions count the other issues, so one step up is index - 1 and one down is index + 1.
		if (moveIssue(issue, group.key, index + step)) {
			// Reordering moves the row's element, which drops its focus.
			requestAnimationFrame(() => focusIssue(issue.id));
		}
	}

	function checkSelected(range: boolean) {
		if (selectedId && visible.some((issue) => issue.id === selectedId)) onCheck(selectedId, range);
	}
	const extendToSelected = () => checkSelected(true);
	const uncheckAll = () => {
		if (checking) selection.clear();
	};

	const next = () => select(1);
	const previous = () => select(-1);
	useHotkeys({
		j: next,
		ArrowDown: next,
		k: previous,
		ArrowUp: previous,
		"alt+ArrowDown": () => moveSelected(1),
		"alt+ArrowUp": () => moveSelected(-1),
		s: () => openMenu("status"),
		p: () => openMenu("priority"),
		a: () => openMenu("assignee"),
		x: () => checkSelected(false),
		X: extendToSelected,
		Escape: uncheckAll,
	});

	function toggle(key: string) {
		setCollapsed((current) => {
			const next = new Set(current);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}

	if (groups.length === 0) return empty;

	// Entries are siblings in one flat list, so a row that changes group moves to its new one
	// without remounting and keeps focus and any open menu. Only the ones near the screen render;
	// spacers keep the list's height and scroll position.
	return (
		<div ref={root}>
			<Spacer height={offsets[start] ?? 0} />
			{entries
				.slice(start, last)
				.map((entry) =>
					entry.kind === "header" ? (
						<GroupHeader
							key={`group-${entry.group.key}`}
							group={entry.group}
							collapsed={entry.collapsed}
							onToggle={toggle}
							defaults={defaults}
						/>
					) : (
						<IssueRow
							key={entry.issue.id}
							issue={entry.issue}
							team={teams.get(entry.issue.teamId)}
							assignee={entry.issue.assigneeId ? members.get(entry.issue.assigneeId) : undefined}
							subIssues={subIssues.get(entry.issue.id)}
							blocked={blocked.has(entry.issue.id)}
							properties={properties}
							selected={entry.issue.id === selectedId}
							checked={checkedIds.has(entry.issue.id)}
							checking={checking}
							onCheck={onCheck}
							menu={menu?.issueId === entry.issue.id ? menu.field : null}
							onMenuChange={onMenuChange}
							onSelect={setSelectedId}
							registerRow={registerRow}
						/>
					),
				)}
			<Spacer height={(offsets[offsets.length - 1] ?? 0) - (offsets[last] ?? 0)} />
			<BulkBar selection={selection} total={visible.length} />
		</div>
	);
}

/** Stands in for the entries that are not rendered, so the list keeps its height. */
function Spacer({ height }: { height: number }) {
	if (height <= 0) return null;
	return <div aria-hidden style={{ height }} />;
}

/**
 * Scrolls the scrolling ancestor, or the page, so the entry starting `top` pixels into the list is
 * in view below the sticky header, which stays over the top of the scroller.
 */
function revealEntry(list: HTMLElement, top: number) {
	const scroller = scrollParent(list);
	const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
	const start = list.getBoundingClientRect().top + top;
	const end = start + ROW_HEIGHT;
	const delta =
		start < view.top + HEADER_HEIGHT
			? start - view.top - HEADER_HEIGHT
			: end > view.bottom
				? end - view.bottom
				: 0;
	if (delta !== 0) (scroller ?? window).scrollBy({ top: delta });
}

/** A group's header. Dropping an issue on it moves the issue to the top of the group. */
function GroupHeader({
	group,
	collapsed,
	onToggle,
	defaults,
}: {
	group: IssueGroup;
	collapsed: boolean;
	onToggle: (key: string) => void;
	defaults: IssueDefaults;
}) {
	const actions = useWorkspaceActions();
	const [ref, over] = useIssueDropZone<HTMLHeadingElement>(group.key, "start");
	const label = useGroupName()(group);

	return (
		<h2
			ref={ref}
			className={cn(
				"sticky top-12 z-20 flex h-9 items-center gap-2 border-b bg-muted/80 px-3 backdrop-blur sm:px-4",
				over && "bg-accent",
			)}
		>
			<button
				type="button"
				onClick={() => onToggle(group.key)}
				aria-expanded={!collapsed}
				className="flex min-w-0 flex-1 items-center gap-2 text-sm"
			>
				<ChevronRight
					className={cn(
						"size-3.5 text-muted-foreground transition-transform",
						!collapsed && "rotate-90",
					)}
				/>
				<GroupIcon group={group} />
				<span className="font-medium">{label}</span>
				<span className="text-muted-foreground tabular-nums">{group.issues.length}</span>
			</button>
			<Button
				variant="ghost"
				size="icon"
				className="size-7"
				aria-label={
					group.by === "status" ? `Create a ${label} issue` : `Create an issue in ${label}`
				}
				onClick={() => actions.createIssue({ ...defaults, ...groupFields(group) })}
			>
				<Plus />
			</Button>
		</h2>
	);
}
