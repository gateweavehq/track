import type {
	Cycle,
	Issue,
	IssueDisplay,
	Member,
	Project,
	TableColumn,
	Team,
} from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ListRestart, SlidersHorizontal } from "lucide-react";
import {
	type CSSProperties,
	forwardRef,
	memo,
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CycleIcon } from "#/components/cycles/meta";
import { MemberAvatar } from "#/components/members/member-avatar";
import { ProjectStatusIcon } from "#/components/projects/meta";
import { Button } from "#/components/ui/button";
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
import { isIssueOverdue, issueKey } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";
import { useCyclesById, useMembersById, useProjectsById, useTeamsById } from "#/lib/queries";
import { nextSort, type SortColumn, sortIssues, type TableSort } from "#/lib/table";
import { cn } from "#/lib/utils";
import { DateField } from "./date-field";
import { LabelChips, LabelPicker } from "./labels";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";
import {
	AssigneePicker,
	CyclePicker,
	EstimatePicker,
	PriorityPicker,
	ProjectPicker,
	StatusPicker,
} from "./pickers";
import { Estimate } from "./schedule";

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

/** Every row is this tall (`h-10`), which is what lets the table render only the rows on screen. */
const ROW_HEIGHT = 40;
/** Rows rendered beyond each edge of the screen, so fast scrolling does not show blank space. */
const OVERSCAN = 15;

/**
 * Issues as a table: a column per property, each editable in place, sorted by clicking a header.
 * It scrolls sideways inside its own container, with the ID and Title columns staying put. The
 * columns and the sort are display options, so they go with the page's link or saved view. Only
 * the rows near the screen are in the page, so a table of thousands opens and sorts as quickly as
 * one of a few dozen.
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
	const shown = useMemo(() => shownColumns(display), [display]);
	const sort: TableSort | null = display.sort ?? null;
	const setSort = (update: (current: TableSort | null) => TableSort | null) =>
		onDisplayChange((current) => ({ ...current, sort: update(current.sort ?? null) ?? undefined }));
	const rows = useMemo(
		() => sortIssues(issues, sort, { teams, members, projects, cycles }),
		[issues, sort, teams, members, projects, cycles],
	);
	const body = useRef<HTMLTableSectionElement>(null);
	const [first, last] = useRowsOnScreen(rows.length, body);
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
			<div className="min-w-0 flex-1 overflow-x-auto border-t">
				<table
					aria-rowcount={rows.length + 1}
					style={{ "--id-width": idWidth } as CSSProperties}
					className="w-max min-w-full border-separate border-spacing-0 text-sm"
				>
					<thead>
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
					<tbody ref={body}>
						<Spacer rows={first} columns={shown.length} />
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
							/>
						))}
						<Spacer rows={rows.length - last} columns={shown.length} />
					</tbody>
				</table>
			</div>
		</div>
	);
}

/** Stands in for rows that are off screen, so the table keeps its height and scroll position. */
function Spacer({ rows, columns }: { rows: number; columns: number }) {
	if (rows <= 0) return null;
	return (
		<tr aria-hidden>
			<td colSpan={columns} className="p-0" style={{ height: rows * ROW_HEIGHT }} />
		</tr>
	);
}

/**
 * The range of rows `[first, last)` near the visible part of the table body, following the
 * scrolling ancestor (the page) as it scrolls or resizes.
 */
function useRowsOnScreen(count: number, body: RefObject<HTMLTableSectionElement | null>) {
	const [range, setRange] = useState<readonly [number, number]>(() => [0, Math.min(count, 50)]);
	useLayoutEffect(() => {
		const element = body.current;
		if (!element) {
			setRange([0, Math.min(count, 50)]);
			return;
		}
		const scroller = scrollParent(element);
		const update = () => {
			const top = element.getBoundingClientRect().top;
			const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
			const first = clamp(Math.floor((view.top - top) / ROW_HEIGHT) - OVERSCAN, count);
			const last = clamp(Math.ceil((view.bottom - top) / ROW_HEIGHT) + OVERSCAN, count);
			setRange((current) =>
				current[0] === first && current[1] === last ? current : [first, Math.max(first, last)],
			);
		};
		update();
		const target = scroller ?? window;
		target.addEventListener("scroll", update, { passive: true });
		const resize = new ResizeObserver(update);
		resize.observe(scroller ?? document.documentElement);
		return () => {
			target.removeEventListener("scroll", update);
			resize.disconnect();
		};
	}, [count, body]);
	return range;
}

function clamp(row: number, count: number) {
	return Math.min(Math.max(row, 0), count);
}

/** The nearest ancestor that scrolls vertically, or none when the document itself scrolls. */
function scrollParent(element: HTMLElement): HTMLElement | null {
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const { overflowY } = getComputedStyle(parent);
		if (overflowY === "auto" || overflowY === "scroll") return parent;
	}
	return null;
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

/** Header and body cells share this; the first two stick to the left edge while the table scrolls. */
function cellEdge(column: TableColumn): string {
	if (column === "id") return "sticky left-0 z-10";
	if (column === "title") return cn("sm:sticky sm:z-10", TITLE_OFFSET);
	return "";
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
				"h-9 whitespace-nowrap border-b bg-background px-2 text-left text-xs font-medium text-muted-foreground first:pl-3 sm:first:pl-4",
				COLUMN_WIDTH[column],
				cellEdge(column),
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
}: {
	/** Its place in the sorted rows, for assistive technology, which sees only those rendered. */
	index: number;
	issue: Issue;
	team: Team | undefined;
	assignee: Member | undefined;
	project: Project | undefined;
	cycle: Cycle | undefined;
	columns: readonly TableColumn[];
}) {
	const { slug } = useWorkspace();
	const update = useUpdateIssue();
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
					<Link
						to="/$workspace/issue/$issueKey"
						params={{ workspace: slug, issueKey: key }}
						title={issue.title}
						className="block w-48 truncate hover:underline sm:w-72"
					>
						{issue.title}
					</Link>
				);
			case "status":
				return (
					<StatusPicker value={issue.status} onChange={(status) => update(issue, { status })}>
						<CellButton label={`Status: ${STATUS_META[issue.status].label}`}>
							<StatusIcon status={issue.status} />
							{STATUS_META[issue.status].label}
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
							overdue={isIssueOverdue(issue)}
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
		<tr aria-rowindex={index + 2} className="group hover:bg-muted/60">
			{columns.map((column) => (
				<td
					key={column}
					className={cn(
						"h-10 whitespace-nowrap border-b bg-background px-2 first:pl-3 group-hover:bg-muted sm:first:pl-4",
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
