import {
	draggable,
	dropTargetForElements,
	monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import type { Issue, Team } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "#/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { useWorkspace } from "#/components/workspace/context";
import {
	addMonths,
	agendaDays,
	formatMonth,
	groupByDueDate,
	monthOf,
	monthWeeks,
} from "#/lib/calendar";
import { formatFullDay, formatShortDay, formatWeekday, today } from "#/lib/dates";
import { isIssueOverdue, issueKey } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";
import { useTeamsById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { StatusIcon } from "./meta";

/** Issues shown in a day's cell before the rest go behind "+N more". */
const VISIBLE_PER_DAY = 3;

const CALENDAR_DRAG = "track/calendar-issue";
const CALENDAR_DAY = "track/calendar-day";

/** The `sm` breakpoint: below it a seven-column month does not fit, so the month is an agenda. */
const WIDE = "(min-width: 640px)";

function subscribeWide(notify: () => void) {
	const query = window.matchMedia(WIDE);
	query.addEventListener("change", notify);
	return () => query.removeEventListener("change", notify);
}

export function useWide(): boolean {
	return useSyncExternalStore(
		subscribeWide,
		() => window.matchMedia(WIDE).matches,
		() => true,
	);
}

/**
 * Issues on a month grid by due date, or on a phone as an agenda of the days that have issues.
 * Dragging an issue to another day sets its due date there. Issues without a due date are not on
 * the grid; a count under the header says how many there are.
 */
export function IssueCalendar({ issues, empty }: { issues: Issue[]; empty: ReactNode }) {
	const teams = useTeamsById();
	const update = useUpdateIssue();
	const wide = useWide();
	const [month, setMonth] = useState(() => monthOf(today()));
	const { byDay, undated } = useMemo(() => groupByDueDate(issues), [issues]);
	const weeks = useMemo(() => monthWeeks(month), [month]);

	// Drops are handled from the latest issues without re-registering the monitor on every sync.
	const latest = useRef({ issues, update });
	latest.current = { issues, update };
	useEffect(
		() =>
			monitorForElements({
				canMonitor: ({ source }) => source.data.kind === CALENDAR_DRAG,
				onDrop: ({ source, location }) => {
					const target = location.current.dropTargets.find(
						(candidate) => candidate.data.kind === CALENDAR_DAY,
					);
					const day = target?.data.day;
					if (typeof day !== "string") return;
					const issue = latest.current.issues.find(({ id }) => id === source.data.issueId);
					if (issue && issue.dueDate !== day) latest.current.update(issue, { dueDate: day });
				},
			}),
		[],
	);

	if (issues.length === 0) return empty;

	const now = today();
	return (
		<div className="flex flex-col gap-3 p-3 sm:p-4">
			<div className="flex flex-wrap items-center gap-2">
				<h2 aria-live="polite" className="mr-auto text-base font-medium">
					{formatMonth(month)}
				</h2>
				<div className="flex items-center gap-1">
					<Button
						variant="outline"
						size="icon"
						className="size-8"
						aria-label="Previous month"
						onClick={() => setMonth(addMonths(month, -1))}
					>
						<ChevronLeft />
					</Button>
					<Button variant="outline" size="sm" onClick={() => setMonth(monthOf(now))}>
						Today
					</Button>
					<Button
						variant="outline"
						size="icon"
						className="size-8"
						aria-label="Next month"
						onClick={() => setMonth(addMonths(month, 1))}
					>
						<ChevronRight />
					</Button>
				</div>
			</div>
			{undated > 0 && (
				<p className="text-sm text-muted-foreground">
					{undated === 1 ? "1 issue" : `${undated} issues`} without a due date
				</p>
			)}
			{wide ? (
				<MonthGrid month={month} weeks={weeks} byDay={byDay} now={now} teams={teams} />
			) : (
				<Agenda month={month} byDay={byDay} now={now} teams={teams} />
			)}
		</div>
	);
}

type Teams = ReadonlyMap<string, Team>;
type ByDay = ReadonlyMap<string, readonly Issue[]>;

function MonthGrid({
	month,
	weeks,
	byDay,
	now,
	teams,
}: {
	month: string;
	weeks: string[][];
	byDay: ByDay;
	now: string;
	teams: Teams;
}) {
	return (
		<table className="w-full table-fixed border-separate border-spacing-0 overflow-hidden rounded-lg border">
			<caption className="sr-only">Issues by due date, {formatMonth(month)}</caption>
			<thead>
				<tr>
					{weeks[0]?.map((day) => (
						<th
							key={day}
							scope="col"
							className="border-b bg-muted/40 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground"
						>
							{formatWeekday(day)}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{weeks.map((week, row) => (
					<tr key={week[0]}>
						{week.map((day, column) => (
							<DayCell
								key={day}
								day={day}
								inMonth={monthOf(day) === month}
								isToday={day === now}
								issues={byDay.get(day) ?? []}
								teams={teams}
								lastRow={row === weeks.length - 1}
								lastColumn={column === 6}
							/>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

function DayCell({
	day,
	inMonth,
	isToday,
	issues,
	teams,
	lastRow,
	lastColumn,
}: {
	day: string;
	inMonth: boolean;
	isToday: boolean;
	issues: readonly Issue[];
	teams: Teams;
	lastRow: boolean;
	lastColumn: boolean;
}) {
	const ref = useRef<HTMLTableCellElement>(null);
	const [over, setOver] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		return dropTargetForElements({
			element,
			canDrop: ({ source }) => source.data.kind === CALENDAR_DRAG,
			getData: () => ({ kind: CALENDAR_DAY, day }),
			onDragEnter: () => setOver(true),
			onDragLeave: () => setOver(false),
			onDrop: () => setOver(false),
		});
	}, [day]);

	const shown = issues.slice(0, VISIBLE_PER_DAY);
	const hidden = issues.slice(VISIBLE_PER_DAY);
	const label = formatFullDay(day);
	return (
		<td
			ref={ref}
			aria-current={isToday ? "date" : undefined}
			className={cn(
				"h-28 min-w-0 align-top p-1 transition-colors",
				!lastRow && "border-b",
				!lastColumn && "border-r",
				!inMonth && "bg-muted/30",
				over && "bg-accent",
			)}
		>
			<div className={cn("flex flex-col gap-0.5", !inMonth && "opacity-60")}>
				<span
					className={cn(
						"mb-0.5 flex size-6 items-center justify-center self-start rounded-full text-xs tabular-nums",
						isToday ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground",
					)}
				>
					<span aria-hidden>{Number(day.slice(8))}</span>
					<span className="sr-only">{label}</span>
				</span>
				{shown.map((issue) => (
					<DraggableIssue key={issue.id} issue={issue} team={teams.get(issue.teamId)} />
				))}
				{hidden.length > 0 && <MoreIssues label={label} issues={hidden} teams={teams} />}
			</div>
		</td>
	);
}

function MoreIssues({
	label,
	issues,
	teams,
}: {
	label: string;
	issues: readonly Issue[];
	teams: Teams;
}) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`Show ${issues.length} more issues due ${label}`}
					className="rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					+{issues.length} more
				</button>
			</PopoverTrigger>
			<PopoverContent className="flex w-72 flex-col gap-0.5 p-1">
				<p className="px-1.5 py-1 text-xs text-muted-foreground">Due {label}</p>
				{issues.map((issue) => (
					<IssueChip key={issue.id} issue={issue} team={teams.get(issue.teamId)} />
				))}
			</PopoverContent>
		</Popover>
	);
}

/** An issue in a day's cell, which can be dragged to another day. */
function DraggableIssue({ issue, team }: { issue: Issue; team: Team | undefined }) {
	const ref = useRef<HTMLDivElement>(null);
	const [dragging, setDragging] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		return draggable({
			element,
			getInitialData: () => ({ kind: CALENDAR_DRAG, issueId: issue.id }),
			onDragStart: () => setDragging(true),
			onDrop: () => setDragging(false),
		});
	}, [issue.id]);
	return (
		<div ref={ref} className={cn(dragging && "opacity-40")}>
			<IssueChip issue={issue} team={team} />
		</div>
	);
}

/** An issue as a link: its status, key and title, in red when it is overdue. */
function IssueChip({
	issue,
	team,
	className,
}: {
	issue: Issue;
	team: Team | undefined;
	className?: string;
}) {
	const { slug } = useWorkspace();
	const key = issueKey(team, issue);
	const overdue = isIssueOverdue(issue);
	return (
		<Link
			to="/$workspace/issue/$issueKey"
			params={{ workspace: slug, issueKey: key }}
			draggable={false}
			title={overdue ? `Overdue: ${issue.title}` : issue.title}
			className={cn(
				"flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
				overdue && "bg-destructive/10 text-destructive hover:bg-destructive/15",
				className,
			)}
		>
			<StatusIcon status={issue.status} className="size-3.5" />
			<span className="shrink-0 font-mono tabular-nums opacity-70">
				<span className="sr-only">{overdue ? "Overdue. " : ""}</span>
				{key}
			</span>
			<span className="truncate">{issue.title}</span>
		</Link>
	);
}

/** The month on a phone: a heading for each day that has issues, with its issues under it. */
function Agenda({
	month,
	byDay,
	now,
	teams,
}: {
	month: string;
	byDay: ByDay;
	now: string;
	teams: Teams;
}) {
	const days = agendaDays(month, byDay);
	if (days.length === 0) {
		return (
			<p className="py-8 text-center text-sm text-muted-foreground">Nothing is due this month.</p>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			{days.map((day) => (
				<section key={day} aria-labelledby={`agenda-${day}`}>
					<h3
						id={`agenda-${day}`}
						aria-current={day === now ? "date" : undefined}
						className={cn("mb-1 text-sm font-medium", day === now && "text-primary")}
					>
						{formatWeekday(day)}, {formatShortDay(day)}
						{day === now && <span className="ml-1.5 font-normal text-xs">Today</span>}
					</h3>
					<ul className="flex flex-col gap-0.5">
						{byDay.get(day)?.map((issue) => (
							<li key={issue.id}>
								<IssueChip
									issue={issue}
									team={teams.get(issue.teamId)}
									className="gap-1.5 px-2 py-2 text-sm"
								/>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
