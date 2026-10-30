import type { Issue, Member, Project, Team } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ListRestart, SlidersHorizontal } from "lucide-react";
import { forwardRef, memo, type ReactNode, useMemo, useState } from "react";
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
import { formatDateTime, formatShortDate } from "#/lib/dates";
import { isIssueOverdue, issueKey } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";
import { useMembersById, useProjectsById, useTeamsById } from "#/lib/queries";
import {
	HIDEABLE_COLUMNS,
	nextSort,
	type SortColumn,
	sortIssues,
	TABLE_COLUMN_LABELS,
	type TableColumn,
	type TableSort,
	useTableColumns,
} from "#/lib/table";
import { cn } from "#/lib/utils";
import { DateField } from "./date-field";
import { LabelChips, LabelPicker } from "./labels";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";
import {
	AssigneePicker,
	EstimatePicker,
	PriorityPicker,
	ProjectPicker,
	StatusPicker,
} from "./pickers";
import { Estimate } from "./schedule";

/** The ID column is as wide as the longest key a team can have, so Title can stick beside it. */
const ID_WIDTH = "w-[5.5rem] min-w-[5.5rem]";
const TITLE_OFFSET = "sm:left-[5.5rem]";

/**
 * Issues as a table: a column per property, each editable in place, sorted by clicking a header.
 * It scrolls sideways inside its own container, with the ID and Title columns staying put. The
 * chosen columns are remembered per page (`scope`); the sort is not.
 */
export function IssueTable({
	issues,
	empty,
	scope,
}: {
	issues: Issue[];
	empty: ReactNode;
	/** What the page remembers its columns by: the scope its view is remembered by. */
	scope: string;
}) {
	const teams = useTeamsById();
	const members = useMembersById();
	const projects = useProjectsById();
	const { shown, toggle } = useTableColumns(scope);
	const [sort, setSort] = useState<TableSort | null>(null);
	const rows = useMemo(
		() => sortIssues(issues, sort, { teams, members, projects }),
		[issues, sort, teams, members, projects],
	);

	if (issues.length === 0) return empty;

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center justify-end gap-2 px-3 py-2 sm:px-4">
				{sort && (
					<Button variant="ghost" size="sm" className="h-8" onClick={() => setSort(null)}>
						<ListRestart />
						Manual order
					</Button>
				)}
				<ColumnsMenu shown={shown} onToggle={toggle} />
			</div>
			<div className="min-w-0 flex-1 overflow-x-auto border-t">
				<table className="w-max min-w-full border-separate border-spacing-0 text-sm">
					<thead>
						<tr>
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
					<tbody>
						{rows.map((issue) => (
							<TableRow
								key={issue.id}
								issue={issue}
								team={teams.get(issue.teamId)}
								assignee={issue.assigneeId ? members.get(issue.assigneeId) : undefined}
								project={issue.projectId ? projects.get(issue.projectId) : undefined}
								columns={shown}
							/>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
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

/** Header cells share this; the first two stick to the left edge while the table scrolls. */
function cellEdge(column: TableColumn): string {
	if (column === "id") return cn("sticky left-0 z-10", ID_WIDTH);
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
	issue,
	team,
	assignee,
	project,
	columns,
}: {
	issue: Issue;
	team: Team | undefined;
	assignee: Member | undefined;
	project: Project | undefined;
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
					<DateField
						label="Start date"
						value={issue.startDate}
						max={issue.dueDate}
						onChange={(startDate) => update(issue, { startDate })}
					/>
				);
			case "dueDate":
				return (
					<DateField
						label="Due date"
						value={issue.dueDate}
						min={issue.startDate}
						overdue={isIssueOverdue(issue)}
						onChange={(dueDate) => update(issue, { dueDate })}
					/>
				);
			case "created":
				return <Timestamp time={issue.createdAt} verb="Created" />;
			case "updated":
				return <Timestamp time={issue.updatedAt} verb="Updated" />;
		}
	};

	return (
		<tr className="group hover:bg-muted/60">
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
