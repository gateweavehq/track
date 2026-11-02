import type {
	Cycle,
	Issue,
	IssueDisplay,
	Member,
	Project,
	TableColumn,
	Team,
} from "@gateweave/track-protocol";
import { isClosedCategory } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ListRestart, SlidersHorizontal } from "lucide-react";
import {
	type CSSProperties,
	forwardRef,
	memo,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CycleIcon } from "#/components/cycles/meta";
import { MemberAvatar } from "#/components/members/member-avatar";
import { ProjectStatusIcon } from "#/components/projects/meta";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { useWorkspace } from "#/components/workspace/context";
import { cycleName, stateIn } from "#/lib/cycles";
import { formatDateTime, formatShortDate } from "#/lib/dates";
import {
	type DisplayUpdate,
	HIDEABLE_COLUMNS,
	shownColumns,
	TABLE_COLUMN_LABELS,
	toggleColumn,
} from "#/lib/display";
import { useHotkeys } from "#/lib/hotkeys";
import { isIssueOverdue, issueKey } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";
import {
	useCyclesById,
	useIssueStatus,
	useMembersById,
	useProjectsById,
	useStatuses,
	useTeamsById,
} from "#/lib/queries";
import { nextSort, type SortColumn, sortIssues, type TableSort } from "#/lib/table";
import { cn } from "#/lib/utils";
import { BulkBar } from "./bulk-bar";
import { DateField } from "./date-field";
import { LabelChips, LabelPicker } from "./labels";
import { PRIORITY_META, PriorityIcon, StatusIcon } from "./meta";
import {
	AssigneePicker,
	CyclePicker,
	EstimatePicker,
	PriorityPicker,
	ProjectPicker,
	StatusPicker,
} from "./pickers";
import { revealEntry, stickyCover, useItemsOnScreen, useMeasuredHeights } from "./rows-on-screen";
import { Estimate } from "./schedule";
import { useIssueSelection } from "./selection";

/**
 * The least each column takes, at least as wide as anything its cells show. Only the rows on
 * screen are rendered, so a column sized by its content would change width while scrolling. The
 * ID column is as wide as the longest key in the table (`--id-width`), so Title can stick beside it.
 */
const COLUMN_WIDTH: Record<TableColumn, string> = {
	id: "w-(--id-width) min-w-(--id-width)",
	title: "",
	status: "min-w-36",
	priority: "min-w-32",
	assignee: "min-w-52",
	project: "min-w-52",
	cycle: "min-w-36",
	labels: "min-w-52",
	estimate: "min-w-24",
	startDate: "min-w-48",
	dueDate: "min-w-48",
	created: "min-w-28",
	updated: "min-w-28",
};
const TITLE_OFFSET = "sm:left-(--id-width)";

/**
 * Every row is the same height, which is what lets the table render only the rows on screen. It is
 * `h-10`, in rem, so the table measures a rendered row (`useMeasuredHeights`); this is that height
 * at the default font size, standing in until one has rendered.
 */
const DEFAULT_HEIGHTS = { row: 40 };
const ROW_SELECTOR = { row: "tr[data-issue-id]" };

/**
 * Issues as a table: a column per property, each editable in place, sorted by clicking a header.
 * It scrolls inside its own container, the ID and Title columns staying put as it scrolls sideways
 * and the header row as it scrolls down. The columns and the sort are display options, so they go
 * with the page's link or saved view. Only the rows near the screen are in the page, so a table of
 * thousands opens and sorts as quickly as one of a few dozen. Rows are picked by their checkboxes,
 * as in a list, to change them together. J/K or the arrow keys move from row to row, as in a list,
 * scrolling to rows not rendered yet.
 */
export function IssueTable({
	issues,
	empty,
	display,
	onDisplayChange,
}: {
	issues: Issue[];
	empty: ReactNode;
	display: IssueDisplay;
	onDisplayChange: (update: DisplayUpdate) => void;
}) {
	const teams = useTeamsById();
	const members = useMembersById();
	const projects = useProjectsById();
	const cycles = useCyclesById();
	const statuses = useStatuses();
	const shown = useMemo(() => shownColumns(display), [display]);
	const sort: TableSort | null = display.sort ?? null;
	const setSort = (update: (current: TableSort | null) => TableSort | null) =>
		onDisplayChange((current) => ({ ...current, sort: update(current.sort ?? null) ?? undefined }));
	const rows = useMemo(
		() => sortIssues(issues, sort, { teams, members, projects, cycles, statuses }),
		[issues, sort, teams, members, projects, cycles, statuses],
	);
	const body = useRef<HTMLTableSectionElement>(null);
	const head = useRef<HTMLTableSectionElement>(null);
	const { row: rowHeight } = useMeasuredHeights(body, ROW_SELECTOR, DEFAULT_HEIGHTS);
	const offsets = useMemo(
		() => Array.from({ length: rows.length + 1 }, (_, index) => index * rowHeight),
		[rows.length, rowHeight],
	);
	const range = useItemsOnScreen(offsets, body);
	const [first, last] = range;
	const selection = useIssueSelection(rows);
	const { checkedIds, checking, onCheck } = selection;
	// The issue whose row last had focus, which J and K move from.
	const focusedId = useRef<string | null>(null);
	// A row to focus once it has been scrolled to and rendered, and the rendered range when it was
	// asked for, as in the list.
	const pendingFocus = useRef<{ issueId: string; range: readonly [number, number] } | null>(null);

	/** The link to a rendered row's issue, which takes focus for the row. */
	const rowLink = (issueId: string) =>
		body.current?.querySelector<HTMLAnchorElement>(
			`tr[data-issue-id="${CSS.escape(issueId)}"] [data-row-link]`,
		) ?? null;

	/**
	 * Focuses a row, scrolled clear of the sticky header and the bulk bar. A row that is not
	 * rendered yet is scrolled to first, and focused once it renders.
	 */
	function focusRow(index: number) {
		const issue = rows[index];
		const element = body.current;
		if (!issue || !element) return;
		const scrolled = revealEntry(
			element,
			index * rowHeight,
			(index + 1) * rowHeight,
			(scroller, viewTop) => Math.max(stickyCover(scroller, viewTop), headerCover(head.current)),
		);
		focusedId.current = issue.id;
		const link = rowLink(issue.id);
		if (link) {
			link.focus({ preventScroll: true });
			return;
		}
		// Not scrolled means it is on screen, so it would be rendered: nothing to wait for.
		pendingFocus.current = scrolled ? { issueId: issue.id, range } : null;
	}

	// After every render, which is when a scrolled-to row first appears. The wait ends once the
	// range has moved without rendering the row, or the row has gone, as in the list.
	useEffect(() => {
		const pending = pendingFocus.current;
		if (!pending) return;
		const link = rowLink(pending.issueId);
		if (link) {
			pendingFocus.current = null;
			link.focus({ preventScroll: true });
		} else if (pending.range !== range || !rows.some((issue) => issue.id === pending.issueId)) {
			pendingFocus.current = null;
		}
	});

	function step(by: 1 | -1) {
		const index = rows.findIndex((issue) => issue.id === focusedId.current);
		focusRow(index === -1 ? (by === 1 ? 0 : rows.length - 1) : index + by);
	}
	const next = () => step(1);
	const previous = () => step(-1);
	const uncheckAll = () => {
		if (checking) selection.clear();
	};
	useHotkeys({
		j: next,
		ArrowDown: next,
		k: previous,
		ArrowUp: previous,
		Escape: uncheckAll,
	});
	// Keys are monospaced, at most about half a rem a character, plus the cell's padding.
	const idWidth = useMemo(() => {
		const longest = Math.max(
			0,
			...rows.map((issue) => issueKey(teams.get(issue.teamId), issue).length),
		);
		return `${longest / 2 + 1.5}rem`;
	}, [rows, teams]);

	if (issues.length === 0) return empty;

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center justify-end gap-2 px-3 py-2 sm:px-4">
				{sort && (
					<Button variant="ghost" size="sm" className="h-8" onClick={() => setSort(() => null)}>
						<ListRestart />
						Manual order
					</Button>
				)}
				<ColumnsMenu
					shown={shown}
					onToggle={(column) => onDisplayChange((current) => toggleColumn(current, column))}
				/>
			</div>
			{/* While issues are picked, room below the last row to scroll it clear of the bar. */}
			<div className={cn("min-w-0 flex-1 overflow-x-auto border-t", checking && "pb-20")}>
				<table
					aria-rowcount={rows.length + 1}
					style={{ "--id-width": idWidth } as CSSProperties}
					className="w-max min-w-full border-separate border-spacing-0 text-sm"
				>
					<thead ref={head}>
						<tr aria-rowindex={1}>
							{shown.map((column) => (
								<HeaderCell
									key={column}
									column={column}
									sort={sort}
									onSort={(next) => setSort((current) => nextSort(current, next))}
								/>
							))}
						</tr>
					</thead>
					<tbody
						ref={body}
						onFocus={(event) => {
							const row = event.target.closest<HTMLElement>("tr[data-issue-id]");
							if (row?.dataset.issueId) focusedId.current = row.dataset.issueId;
						}}
					>
						<Spacer height={offsets[first] ?? 0} columns={shown.length} />
						{rows.slice(first, last).map((issue, index) => (
							<TableRow
								key={issue.id}
								index={first + index}
								issue={issue}
								team={teams.get(issue.teamId)}
								assignee={issue.assigneeId ? members.get(issue.assigneeId) : undefined}
								project={issue.projectId ? projects.get(issue.projectId) : undefined}
								cycle={issue.cycleId ? cycles.get(issue.cycleId) : undefined}
								columns={shown}
								checked={checkedIds.has(issue.id)}
								checking={checking}
								onCheck={onCheck}
							/>
						))}
						<Spacer
							height={(offsets[rows.length] ?? 0) - (offsets[last] ?? 0)}
							columns={shown.length}
						/>
					</tbody>
				</table>
			</div>
			<BulkBar selection={selection} total={rows.length} />
		</div>
	);
}

/** Stands in for rows that are off screen, so the table keeps its height and scroll position. */
function Spacer({ height, columns }: { height: number; columns: number }) {
	if (height <= 0) return null;
	return (
		<tr aria-hidden>
			<td colSpan={columns} className="p-0" style={{ height }} />
		</tr>
	);
}

/**
 * How far the header row covers the top of the scroller when it sticks there, at its own `top`,
 * once the table has scrolled; nothing when it does not stick.
 */
function headerCover(head: HTMLTableSectionElement | null): number {
	let covered = 0;
	for (const cell of head?.querySelectorAll("th") ?? []) {
		const style = getComputedStyle(cell);
		const top = Number.parseFloat(style.top);
		if (style.position !== "sticky" || Number.isNaN(top)) continue;
		covered = Math.max(covered, top + cell.getBoundingClientRect().height);
	}
	return covered;
}

function ColumnsMenu({
	shown,
	onToggle,
}: {
	shown: readonly TableColumn[];
	onToggle: (column: TableColumn) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2">
					<SlidersHorizontal className="size-3.5" />
					Columns
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuLabel>Show columns</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{HIDEABLE_COLUMNS.map((column) => (
					<DropdownMenuCheckboxItem
						key={column}
						checked={shown.includes(column)}
						// Keep the menu open, so several columns can be changed at once.
						onSelect={(event) => event.preventDefault()}
						onCheckedChange={() => onToggle(column)}
					>
						{TABLE_COLUMN_LABELS[column]}
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Body cells: the first two stick to the left edge while the table scrolls sideways. */
function cellEdge(column: TableColumn): string {
	if (column === "id") return "sticky left-0 z-10";
	if (column === "title") return cn("sm:sticky sm:z-10", TITLE_OFFSET);
	return "";
}

/**
 * Header cells stick to the top as the rows scroll beneath them, above the rows' sticky cells,
 * and the first two to the left edge as well, above the other headers that scroll under them.
 */
function headerEdge(column: TableColumn): string {
	if (column === "id") return "left-0 z-30";
	if (column === "title") return cn("z-20 sm:z-30", TITLE_OFFSET);
	return "z-20";
}

function HeaderCell({
	column,
	sort,
	onSort,
}: {
	column: TableColumn;
	sort: TableSort | null;
	onSort: (column: SortColumn) => void;
}) {
	const label = TABLE_COLUMN_LABELS[column];
	const sorted = sort?.column === column ? sort.direction : null;
	return (
		<th
			scope="col"
			aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
			className={cn(
				"sticky top-0 h-9 whitespace-nowrap border-b bg-background px-2 text-left text-xs font-medium text-muted-foreground first:pl-3 sm:first:pl-4",
				COLUMN_WIDTH[column],
				headerEdge(column),
			)}
		>
			{column === "labels" ? (
				label
			) : (
				<button
					type="button"
					onClick={() => onSort(column)}
					title={`Sort by ${label.toLowerCase()}`}
					className="-mx-1 flex h-7 items-center gap-1 rounded-md px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					{label}
					{sorted === "asc" && <ArrowUp aria-hidden className="size-3" />}
					{sorted === "desc" && <ArrowDown aria-hidden className="size-3" />}
				</button>
			)}
		</th>
	);
}

const TableRow = memo(function TableRow({
	index,
	issue,
	team,
	assignee,
	project,
	cycle,
	columns,
	checked,
	checking,
	onCheck,
}: {
	/** Its place in the sorted rows, for assistive technology, which sees only those rendered. */
	index: number;
	issue: Issue;
	team: Team | undefined;
	assignee: Member | undefined;
	project: Project | undefined;
	cycle: Cycle | undefined;
	columns: readonly TableColumn[];
	/** Whether it is among the issues picked to change together. */
	checked: boolean;
	/** Whether any issue is picked, so every row shows its checkbox. */
	checking: boolean;
	onCheck: (issueId: string, range: boolean) => void;
}) {
	const { slug } = useWorkspace();
	const update = useUpdateIssue();
	const issueStatus = useIssueStatus(issue);
	const key = issueKey(team, issue);

	const cell = (column: TableColumn): ReactNode => {
		switch (column) {
			case "id":
				return (
					<Link
						to="/$workspace/issue/$issueKey"
						params={{ workspace: slug, issueKey: key }}
						className="font-mono text-xs text-muted-foreground tabular-nums hover:text-foreground"
					>
						{key}
					</Link>
				);
			case "title":
				return (
					<div className="flex items-center gap-2">
						<Checkbox
							checked={checked}
							aria-label={`Select ${key}`}
							onClick={(event) => {
								// Toggled here, with the Shift key in hand, rather than by Radix.
								event.preventDefault();
								onCheck(issue.id, event.shiftKey);
							}}
							className={cn(
								"border-muted-foreground/60",
								!checking &&
									!checked &&
									"opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
							)}
						/>
						<Link
							to="/$workspace/issue/$issueKey"
							params={{ workspace: slug, issueKey: key }}
							title={issue.title}
							data-row-link
							className="block w-48 truncate hover:underline sm:w-72"
						>
							{issue.title}
						</Link>
					</div>
				);
			case "status":
				return (
					<StatusPicker
						teamId={issue.teamId}
						value={issue.status}
						onChange={(status) => update(issue, { status })}
					>
						<CellButton label={`Status: ${issueStatus.name}`}>
							<StatusIcon status={issueStatus} />
							{issueStatus.name}
						</CellButton>
					</StatusPicker>
				);
			case "priority":
				return (
					<PriorityPicker
						value={issue.priority}
						onChange={(priority) => update(issue, { priority })}
					>
						<CellButton label={`Priority: ${PRIORITY_META[issue.priority].label}`}>
							<PriorityIcon priority={issue.priority} />
							{PRIORITY_META[issue.priority].label}
						</CellButton>
					</PriorityPicker>
				);
			case "assignee":
				return (
					<AssigneePicker
						value={issue.assigneeId}
						onChange={(assigneeId) => update(issue, { assigneeId })}
					>
						<CellButton label={assignee ? `Assignee: ${assignee.name}` : "Assignee: none"}>
							<MemberAvatar member={assignee} />
							<span className={cn("truncate", !assignee && "text-muted-foreground")}>
								{assignee?.name ?? "Unassigned"}
							</span>
						</CellButton>
					</AssigneePicker>
				);
			case "project":
				return (
					<ProjectPicker
						value={issue.projectId}
						onChange={(projectId) => update(issue, { projectId })}
					>
						<CellButton label={project ? `Project: ${project.name}` : "Project: none"}>
							{project ? (
								<>
									<ProjectStatusIcon status={project.status} />
									<span className="truncate">{project.name}</span>
								</>
							) : (
								<Empty />
							)}
						</CellButton>
					</ProjectPicker>
				);
			case "cycle":
				return (
					<CyclePicker
						teamId={issue.teamId}
						value={issue.cycleId}
						onChange={(cycleId) => update(issue, { cycleId })}
					>
						<CellButton label={cycle ? `Cycle: ${cycleName(cycle)}` : "Cycle: none"}>
							{cycle ? (
								<>
									<CycleIcon state={stateIn(cycle, team, Date.now())} />
									<span className="truncate">{cycleName(cycle)}</span>
								</>
							) : (
								<Empty />
							)}
						</CellButton>
					</CyclePicker>
				);
			case "labels":
				return (
					<LabelPicker issue={issue}>
						<CellButton label="Labels">
							{issue.labelIds.length > 0 ? (
								<LabelChips labelIds={issue.labelIds} max={3} />
							) : (
								<Empty />
							)}
						</CellButton>
					</LabelPicker>
				);
			case "estimate":
				return (
					<EstimatePicker
						value={issue.estimate}
						onChange={(estimate) => update(issue, { estimate })}
					>
						<CellButton
							label={issue.estimate === null ? "Estimate: none" : `Estimate: ${issue.estimate}`}
						>
							{issue.estimate === null ? <Empty /> : <Estimate estimate={issue.estimate} />}
						</CellButton>
					</EstimatePicker>
				);
			case "startDate":
				return (
					<div className="w-44">
						<DateField
							label="Start date"
							value={issue.startDate}
							max={issue.dueDate}
							onChange={(startDate) => update(issue, { startDate })}
						/>
					</div>
				);
			case "dueDate":
				return (
					<div className="w-44">
						<DateField
							label="Due date"
							value={issue.dueDate}
							min={issue.startDate}
							overdue={isIssueOverdue(issue, isClosedCategory(issueStatus.category))}
							onChange={(dueDate) => update(issue, { dueDate })}
						/>
					</div>
				);
			case "created":
				return <Timestamp time={issue.createdAt} verb="Created" />;
			case "updated":
				return <Timestamp time={issue.updatedAt} verb="Updated" />;
		}
	};

	return (
		<tr
			aria-rowindex={index + 2}
			data-issue-id={issue.id}
			data-checked={checked}
			className="group hover:bg-muted/60"
		>
			{columns.map((column) => (
				<td
					key={column}
					className={cn(
						"h-10 whitespace-nowrap border-b bg-background px-2 first:pl-3 group-focus-within:bg-muted group-hover:bg-muted group-data-[checked=true]:bg-accent sm:first:pl-4",
						cellEdge(column),
					)}
				>
					{cell(column)}
				</td>
			))}
		</tr>
	);
});

function Timestamp({ time, verb }: { time: number; verb: string }) {
	return (
		<time
			dateTime={new Date(time).toISOString()}
			title={`${verb} ${formatDateTime(time)}`}
			className="text-xs text-muted-foreground"
		>
			{formatShortDate(time)}
		</time>
	);
}

function Empty() {
	return <span className="text-muted-foreground">&mdash;</span>;
}

/** The trigger of a picker, shaped like a cell's value. */
const CellButton = forwardRef<HTMLButtonElement, { label: string; children: ReactNode }>(
	function CellButton({ label, children, ...props }, ref) {
		return (
			<button
				ref={ref}
				type="button"
				aria-label={label}
				title={label}
				className="-mx-1 flex h-8 max-w-48 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				{...props}
			>
				{children}
			</button>
		);
	},
);
