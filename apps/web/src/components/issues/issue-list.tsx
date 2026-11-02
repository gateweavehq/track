import type { Issue, IssueDisplay } from "@gateweave/track-protocol";
import { ChevronRight, Plus } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
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

/**
 * Heights of the list's two kinds of entry, `h-9` and `h-10` with borders included, in pixels at
 * the default font size. They are rem, so the list measures the real ones (`useEntryHeights`);
 * these stand in until a row and a header have rendered.
 */
const DEFAULT_HEIGHTS: EntryHeights = { header: 36, row: 40 };

interface EntryHeights {
	header: number;
	row: number;
}

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
	const root = useRef<HTMLUListElement>(null);
	// An issue to focus once it has been scrolled to and rendered, and the rendered range when it
	// was asked for; see focusIssue.
	const pendingFocus = useRef<{ issueId: string; range: readonly [number, number] } | null>(null);
	const heights = useEntryHeights(root);

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
				(starts[starts.length - 1] ?? 0) + (entry.kind === "header" ? heights.header : heights.row),
			);
		}
		return starts;
	}, [entries, heights]);
	const entryIndex = useMemo(
		() => new Map(entries.map((entry, index) => [entry, index])),
		[entries],
	);
	const entryOf = useMemo(() => {
		const indexes = new Map<string, number>();
		entries.forEach((entry, index) => {
			if (entry.kind === "row") indexes.set(entry.issue.id, index);
		});
		return indexes;
	}, [entries]);
	const range = useItemsOnScreen(offsets, root);
	const [first, last] = range;
	// The header of the group the first rendered row belongs to is rendered too, so it can stick.
	// The rows between it and the first rendered row are not: a spacer stands in for them.
	let stuck = first;
	while (stuck > 0 && entries[stuck]?.kind === "row") stuck--;
	const header = stuck < first && entries[stuck]?.kind === "header" ? stuck : null;
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
	 * Focuses an issue's row, which selects it (onFocus), scrolled clear of the sticky headers. A
	 * row that is not rendered yet is scrolled to first, and focused once it renders.
	 */
	function focusIssue(issueId: string) {
		const index = entryOf.get(issueId);
		const element = root.current;
		const scrolled =
			index !== undefined && element !== null && revealEntry(element, offsets[index] ?? 0, heights);
		const link = rows.current.get(issueId);
		if (link) {
			link.focus({ preventScroll: true });
			return;
		}
		// Not scrolled means it is on screen, so it would be rendered: nothing to wait for.
		pendingFocus.current = scrolled ? { issueId, range } : null;
	}

	// Runs after every render, which is when a scrolled-to row first appears. The wait ends there:
	// once the range has moved without rendering the row, or the row can no longer render, such as
	// in a group just collapsed or filtered out, so a stale one cannot take focus later.
	useEffect(() => {
		const pending = pendingFocus.current;
		if (!pending) return;
		const link = rows.current.get(pending.issueId);
		if (link) {
			pendingFocus.current = null;
			link.focus({ preventScroll: true });
		} else if (!entryOf.has(pending.issueId) || pending.range !== range) {
			pendingFocus.current = null;
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

	const renderEntry = (entry: ListEntry) =>
		entry.kind === "header" ? (
			// `contents`, so the header sticks within the list rather than within this item.
			<li
				key={`group-${entry.group.key}`}
				aria-posinset={(entryIndex.get(entry) ?? 0) + 1}
				aria-setsize={entries.length}
				className="contents"
			>
				<GroupHeader
					group={entry.group}
					collapsed={entry.collapsed}
					onToggle={toggle}
					defaults={defaults}
				/>
			</li>
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
				position={(entryIndex.get(entry) ?? 0) + 1}
				setSize={entries.length}
			/>
		);
	// One keyed run, so the stuck header stays mounted as it joins the rendered entries.
	const rendered: ReactNode[] = [];
	const stuckHeader = header === null ? undefined : entries[header];
	if (header !== null && stuckHeader) {
		rendered.push(
			renderEntry(stuckHeader),
			<Spacer key="gap" height={(offsets[first] ?? 0) - (offsets[header + 1] ?? 0)} />,
		);
	}
	for (const entry of entries.slice(first, last)) rendered.push(renderEntry(entry));

	// Entries are siblings in one flat list, so a row that changes group moves to its new one
	// without remounting and keeps focus and any open menu. Only the ones near the screen render;
	// spacers keep the list's height and scroll position, and each item says where it is in the
	// whole list, for screen readers. Find in page only finds what is rendered, as in the table.
	return (
		<>
			{/* While issues are picked, room below the last row to scroll it clear of the bar. */}
			<ul ref={root} aria-label="Issues" className={cn(checking && "pb-20")}>
				<Spacer height={offsets[header ?? first] ?? 0} />
				{rendered}
				<Spacer height={(offsets[offsets.length - 1] ?? 0) - (offsets[last] ?? 0)} />
			</ul>
			<BulkBar selection={selection} total={visible.length} />
		</>
	);
}

/** Stands in for the entries that are not rendered, so the list keeps its height. */
function Spacer({ height }: { height: number }) {
	if (height <= 0) return null;
	return <li aria-hidden style={{ height }} />;
}

/**
 * The real heights of a row and a group header: they are set in rem, so they follow the browser's
 * font size. Measured from the first rendered one of each, and again whenever either resizes.
 */
function useEntryHeights(list: RefObject<HTMLElement | null>): EntryHeights {
	const [heights, setHeights] = useState(DEFAULT_HEIGHTS);
	const watched = useRef<{ row: Element | null; header: Element | null }>({
		row: null,
		header: null,
	});
	const observer = useRef<ResizeObserver | null>(null);
	useEffect(() => () => observer.current?.disconnect(), []);
	// After every render, since the rows measured may have scrolled away and been unmounted.
	useLayoutEffect(() => {
		const element = list.current;
		if (!element) return;
		const row = element.querySelector("[data-checked]");
		const header = element.querySelector("[data-group-header]");
		if (row === watched.current.row && header === watched.current.header) return;
		watched.current = { row, header };
		const measure = () => {
			setHeights((current) => {
				const next = {
					row: row?.getBoundingClientRect().height || current.row,
					header: header?.getBoundingClientRect().height || current.header,
				};
				return next.row === current.row && next.header === current.header ? current : next;
			});
		};
		measure();
		observer.current?.disconnect();
		observer.current = new ResizeObserver(measure);
		if (row) observer.current.observe(row);
		if (header) observer.current.observe(header);
	});
	return heights;
}

/**
 * How far down from the top of `view` sticky content covers the list once it has scrolled: the
 * scroller's own sticky children, such as the page's header and its filters, and a group header,
 * which sticks at its own `top`.
 */
function coveredHeight(
	scroller: HTMLElement | null,
	list: HTMLElement,
	viewTop: number,
	header: number,
) {
	let covered = 0;
	for (const child of scroller?.children ?? []) {
		if (getComputedStyle(child).position !== "sticky") continue;
		covered = Math.max(covered, child.getBoundingClientRect().bottom - viewTop);
	}
	const groupHeader = list.querySelector("[data-group-header]");
	if (groupHeader) {
		const top = Number.parseFloat(getComputedStyle(groupHeader).top) || 0;
		covered = Math.max(covered, top + header);
	}
	return covered;
}

/**
 * Scrolls the scrolling ancestor, or the page, so the entry starting `top` pixels into the list is
 * in view, clear of the sticky headers over the top of the scroller and of the bulk-edit bar.
 * Says whether it scrolled.
 */
function revealEntry(list: HTMLElement, top: number, heights: EntryHeights): boolean {
	const scroller = scrollParent(list);
	const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
	const covered = coveredHeight(scroller, list, view.top, heights.header);
	// The bulk-edit bar floats over the bottom while issues are picked.
	const bar = document.querySelector("[data-bulk-bar]")?.getBoundingClientRect().top;
	const bottom = Math.min(view.bottom, bar ?? view.bottom);
	const start = list.getBoundingClientRect().top + top;
	const end = start + heights.row;
	const delta =
		start < view.top + covered ? start - view.top - covered : end > bottom ? end - bottom : 0;
	if (delta === 0) return false;
	(scroller ?? window).scrollBy({ top: delta });
	return true;
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
			data-group-header
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
