import type { Issue, IssueStatus, Team } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type PointerEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { formatMonth } from "#/lib/calendar";
import { addDays, formatShortDay, formatWeekday, today } from "#/lib/dates";
import { isIssueOverdue, issueKey } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";
import { useTeamsById } from "#/lib/queries";
import {
	barColumns,
	type Dates,
	type DragMode,
	daysBetween,
	draggedDates,
	dragPatch,
	initialWindowStart,
	issueSpan,
	isWeekend,
	monthSpans,
	type TimelineRow,
	timelineRows,
	WINDOW_STEP,
	windowDays,
} from "#/lib/timeline";
import { cn } from "#/lib/utils";
import { useWide } from "./issue-calendar";
import { StatusIcon } from "./meta";

/** Width of a day's column, and of the sticky column of issue labels, in pixels. */
const DAY_WIDTH = 36;
const LABEL_WIDTH = 224;

interface BarTone {
	fill: string;
	/** Where the gradient of an open-ended bar starts. */
	fade: string;
	border: string;
}

/** A bar takes the color of its status, as the status icon does; overdue ones are red. */
const BAR_TONES: Record<IssueStatus, BarTone> = {
	backlog: {
		fill: "bg-muted",
		fade: "from-muted-foreground/20",
		border: "border-muted-foreground/30",
	},
	todo: { fill: "bg-foreground/5", fade: "from-foreground/15", border: "border-foreground/25" },
	in_progress: {
		fill: "bg-amber-500/15",
		fade: "from-amber-500/25",
		border: "border-amber-500/50",
	},
	in_review: {
		fill: "bg-emerald-500/15",
		fade: "from-emerald-500/25",
		border: "border-emerald-500/50",
	},
	done: { fill: "bg-indigo-500/10", fade: "from-indigo-500/20", border: "border-indigo-500/40" },
	canceled: {
		fill: "bg-muted",
		fade: "from-muted-foreground/15",
		border: "border-muted-foreground/25",
	},
};
const OVERDUE_TONE: BarTone = {
	fill: "bg-destructive/15",
	fade: "from-destructive/25",
	border: "border-destructive/50",
};

/** Pointer travel before a press on a bar becomes a drag, so that a click still opens the issue. */
const DRAG_THRESHOLD = 3;

type Teams = ReadonlyMap<string, Team>;

/**
 * Issues as bars from their start date to their due date on a twelve-week window of days, which
 * can be moved by dragging a bar and stretched by dragging its edges. An issue with one date gets
 * a one-day bar that fades on its open side. Issues with neither date are not on the chart; a
 * count under the header says how many there are. On a phone the chart is a list of date ranges.
 */
export function IssueTimeline({ issues, empty }: { issues: Issue[]; empty: ReactNode }) {
	const teams = useTeamsById();
	const wide = useWide();
	const [start, setStart] = useState(() => initialWindowStart(today()));
	const { rows, undated } = useMemo(() => timelineRows(issues), [issues]);
	const days = useMemo(() => windowDays(start), [start]);
	const visible = useMemo(
		() => rows.filter((row) => barColumns(row.span, start) !== null),
		[rows, start],
	);

	if (issues.length === 0) return empty;

	const now = today();
	const last = days[days.length - 1] ?? start;
	const outside = rows.length - visible.length;
	return (
		<div className="flex flex-col gap-3 p-3 sm:p-4">
			{wide ? (
				<div className="flex flex-wrap items-center gap-2">
					<h2 aria-live="polite" className="mr-auto text-base font-medium">
						{formatShortDay(start)} to {formatShortDay(last)}
					</h2>
					<div className="flex items-center gap-1">
						<Button
							variant="outline"
							size="icon"
							className="size-8"
							aria-label="Previous weeks"
							onClick={() => setStart(addDays(start, -WINDOW_STEP))}
						>
							<ChevronLeft />
						</Button>
						<Button variant="outline" size="sm" onClick={() => setStart(initialWindowStart(now))}>
							Today
						</Button>
						<Button
							variant="outline"
							size="icon"
							className="size-8"
							aria-label="Next weeks"
							onClick={() => setStart(addDays(start, WINDOW_STEP))}
						>
							<ChevronRight />
						</Button>
					</div>
				</div>
			) : null}
			{undated > 0 && (
				<p className="text-sm text-muted-foreground">
					{undated === 1 ? "1 issue" : `${undated} issues`} without dates
				</p>
			)}
			{wide ? (
				<>
					{outside > 0 && (
						<p className="text-sm text-muted-foreground">
							{outside === 1 ? "1 dated issue is" : `${outside} dated issues are`} outside these
							weeks
						</p>
					)}
					{visible.length === 0 ? (
						<p className="py-8 text-center text-sm text-muted-foreground">
							Nothing is scheduled in these weeks.
						</p>
					) : (
						<Chart rows={visible} days={days} start={start} now={now} teams={teams} />
					)}
				</>
			) : (
				<PhoneList rows={rows} teams={teams} />
			)}
		</div>
	);
}

function Chart({
	rows,
	days,
	start,
	now,
	teams,
}: {
	rows: TimelineRow[];
	days: string[];
	start: string;
	now: string;
	teams: Teams;
}) {
	const trackWidth = days.length * DAY_WIDTH;
	const todayColumn = daysBetween(start, now);
	return (
		<section aria-label="Timeline" className="overflow-x-auto rounded-lg border">
			<div className="relative" style={{ width: LABEL_WIDTH + trackWidth }}>
				{/* Weekend shading behind everything; the day headers sit on it too. */}
				<div
					aria-hidden
					className="pointer-events-none absolute inset-y-0 flex"
					style={{ left: LABEL_WIDTH, width: trackWidth }}
				>
					{days.map((day) => (
						<div
							key={day}
							className={cn(
								"h-full shrink-0 border-l first:border-l-0",
								isWeekend(day) && "bg-muted/50",
							)}
							style={{ width: DAY_WIDTH }}
						/>
					))}
				</div>
				{todayColumn >= 0 && todayColumn < days.length && (
					<div
						aria-hidden
						data-testid="timeline-today"
						className="pointer-events-none absolute inset-y-0 z-20 w-px bg-primary"
						style={{ left: LABEL_WIDTH + todayColumn * DAY_WIDTH + DAY_WIDTH / 2 }}
					/>
				)}
				<div className="relative flex border-b" aria-hidden>
					<div
						className="sticky left-0 z-30 flex shrink-0 items-end border-r bg-muted px-3 pb-1.5 text-xs font-medium text-muted-foreground"
						style={{ width: LABEL_WIDTH }}
					>
						Issue
					</div>
					<div>
						<div className="flex border-b">
							{monthSpans(days).map((span) => (
								<div
									key={span.month}
									className="truncate border-l px-2 py-1 text-xs font-medium first:border-l-0"
									style={{ width: span.count * DAY_WIDTH }}
								>
									{formatMonth(span.month)}
								</div>
							))}
						</div>
						<div className="flex">
							{days.map((day) => (
								<div
									key={day}
									className={cn(
										"flex shrink-0 flex-col items-center py-1 text-[10px] leading-tight text-muted-foreground tabular-nums",
										day === now && "font-semibold text-primary",
									)}
									style={{ width: DAY_WIDTH }}
								>
									<span>{formatWeekday(day).slice(0, 2)}</span>
									<span className="text-xs">{Number(day.slice(8))}</span>
								</div>
							))}
						</div>
					</div>
				</div>
				{rows.map((row) => (
					<ChartRow
						key={row.issue.id}
						row={row}
						start={start}
						team={teams.get(row.issue.teamId)}
						trackWidth={trackWidth}
					/>
				))}
			</div>
		</section>
	);
}

function ChartRow({
	row,
	start,
	team,
	trackWidth,
}: {
	row: TimelineRow;
	start: string;
	team: Team | undefined;
	trackWidth: number;
}) {
	const { slug } = useWorkspace();
	const { issue } = row;
	const key = issueKey(team, issue);
	return (
		<div className="relative flex h-9 border-b last:border-b-0">
			<div
				className="sticky left-0 z-30 shrink-0 border-r bg-background"
				style={{ width: LABEL_WIDTH }}
			>
				<Link
					to="/$workspace/issue/$issueKey"
					params={{ workspace: slug, issueKey: key }}
					draggable={false}
					title={issue.title}
					className="flex h-full min-w-0 items-center gap-1.5 px-3 text-xs outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
				>
					<StatusIcon status={issue.status} className="size-3.5 shrink-0" />
					<span className="shrink-0 font-mono tabular-nums opacity-70">{key}</span>
					<span className="truncate">{issue.title}</span>
				</Link>
			</div>
			<div className="relative shrink-0" style={{ width: trackWidth }}>
				<Bar issue={issue} issueLabel={key} start={start} />
			</div>
		</div>
	);
}

/** "Mar 3 to Mar 10", "starts Mar 3" or "due Mar 10". */
function describeDates({ startDate, dueDate }: Dates): string {
	if (startDate !== null && dueDate !== null) {
		return `${formatShortDay(startDate)} to ${formatShortDay(dueDate)}`;
	}
	if (startDate !== null) return `starts ${formatShortDay(startDate)}`;
	return dueDate === null ? "" : `due ${formatShortDay(dueDate)}`;
}

interface Drag {
	mode: DragMode;
	/** Whole days the pointer has moved, which is what the dates shift by. */
	days: number;
}

/**
 * An issue's bar. Pressing it and moving moves both dates; pressing an edge and moving changes
 * only that edge's date. The new dates show while dragging and are written once, on release.
 */
function Bar({ issue, issueLabel, start }: { issue: Issue; issueLabel: string; start: string }) {
	const { slug } = useWorkspace();
	const update = useUpdateIssue();
	const [drag, setDrag] = useState<Drag | null>(null);
	// The press that may become a drag: where it began, and what it grabbed.
	const press = useRef<{ x: number; mode: DragMode; moved: boolean } | null>(null);
	const suppressClick = useRef(false);
	const link = useRef<HTMLAnchorElement>(null);

	const dates: Dates = drag ? draggedDates(issue, drag.mode, drag.days) : issue;
	const span = issueSpan(dates);
	const columns = span ? barColumns(span, start) : null;
	if (!span || !columns) return null;

	const openEnded = dates.startDate === null || dates.dueDate === null;
	const overdue = isIssueOverdue({ dueDate: dates.dueDate, status: issue.status });
	const label = `${issueLabel}, ${describeDates(dates)}${overdue ? ", overdue" : ""}`;

	function begin(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		const target = event.target instanceof HTMLElement ? event.target.dataset.edge : undefined;
		const mode: DragMode = target === "start" || target === "end" ? target : "move";
		// Capturing keeps the drag going when the pointer leaves the bar, which it does at once from an edge.
		event.currentTarget.setPointerCapture(event.pointerId);
		press.current = { x: event.clientX, mode, moved: false };
		suppressClick.current = false;
	}

	function track(event: PointerEvent<HTMLDivElement>) {
		const current = press.current;
		if (!current) return;
		const distance = event.clientX - current.x;
		if (!current.moved) {
			if (Math.abs(distance) < DRAG_THRESHOLD) return;
			current.moved = true;
		}
		const days = Math.round(distance / DAY_WIDTH);
		// A bar dragged clear out of the window would unmount and drop the drag; hold it at the edge.
		const next = issueSpan(draggedDates(issue, current.mode, days));
		if (next && barColumns(next, start) === null) return;
		setDrag((previous) =>
			previous?.mode === current.mode && previous.days === days
				? previous
				: { mode: current.mode, days },
		);
	}

	function finish(event: PointerEvent<HTMLDivElement>, commit: boolean) {
		const current = press.current;
		press.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		if (!current?.moved) return;
		suppressClick.current = true;
		const patch = commit && drag ? dragPatch(issue, drag.mode, drag.days) : null;
		setDrag(null);
		if (patch) update(issue, patch);
	}

	const { first, last, cutStart, cutEnd } = columns;
	const tone = overdue ? OVERDUE_TONE : BAR_TONES[issue.status];
	return (
		// The pointer handlers are an extra for mouse and touch: keyboard and screen reader users
		// reach the issue through the link inside, and change its dates on the issue page.
		// biome-ignore lint/a11y/noStaticElementInteractions: see above
		// biome-ignore lint/a11y/useKeyWithClickEvents: the click only forwards to the link
		<div
			onPointerDown={begin}
			onPointerMove={track}
			onPointerUp={(event) => finish(event, true)}
			onPointerCancel={(event) => finish(event, false)}
			onClickCapture={(event) => {
				if (!suppressClick.current) return;
				suppressClick.current = false;
				event.preventDefault();
				event.stopPropagation();
			}}
			onClick={(event) => {
				// Pointer capture sends a click to the bar itself; pass it on to the link beneath.
				if (event.target === event.currentTarget) link.current?.click();
			}}
			className={cn(
				"group absolute inset-y-1.5 touch-none select-none",
				drag ? "z-10 cursor-grabbing" : "cursor-grab",
			)}
			style={{ left: first * DAY_WIDTH + 1, width: (last - first + 1) * DAY_WIDTH - 2 }}
		>
			<Link
				ref={link}
				to="/$workspace/issue/$issueKey"
				params={{ workspace: slug, issueKey: issueLabel }}
				draggable={false}
				aria-label={label}
				title={overdue ? `Overdue: ${issue.title}` : issue.title}
				className={cn(
					"flex h-full min-w-0 items-center gap-1 overflow-hidden rounded border px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
					tone.border,
					overdue ? "text-destructive" : "text-foreground",
					// An open-ended bar fades toward the side whose date is missing.
					openEnded
						? cn(
								tone.fade,
								"to-transparent",
								dates.startDate === null
									? "bg-linear-to-l border-l-0 rounded-l-none"
									: "bg-linear-to-r border-r-0 rounded-r-none",
							)
						: tone.fill,
					cutStart && "rounded-l-none border-l-0",
					cutEnd && "rounded-r-none border-r-0",
				)}
			>
				<StatusIcon status={issue.status} className="size-3.5 shrink-0" />
				{/* A day is too narrow for any of the title; the icon and the tooltip say enough. */}
				{last > first && <span className="truncate">{issue.title}</span>}
			</Link>
			{!cutStart && (
				<span
					aria-hidden
					data-edge="start"
					className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize rounded-l hover:bg-primary/30"
				/>
			)}
			{!cutEnd && (
				<span
					aria-hidden
					data-edge="end"
					className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize rounded-r hover:bg-primary/30"
				/>
			)}
			{drag && (
				<span
					aria-hidden
					className="pointer-events-none absolute bottom-full left-0 z-40 mb-0.5 whitespace-nowrap rounded border bg-popover px-1.5 py-0.5 text-xs text-popover-foreground shadow-sm"
				>
					{describeDates(dates)}
				</span>
			)}
		</div>
	);
}

/** On a phone: the dated issues by start date, each with its dates. */
function PhoneList({ rows, teams }: { rows: TimelineRow[]; teams: Teams }) {
	const { slug } = useWorkspace();
	if (rows.length === 0) {
		return <p className="py-8 text-center text-sm text-muted-foreground">No issues have dates.</p>;
	}
	return (
		<ul className="flex flex-col gap-0.5">
			{rows.map(({ issue }) => {
				const key = issueKey(teams.get(issue.teamId), issue);
				const overdue = isIssueOverdue(issue);
				return (
					<li key={issue.id}>
						<Link
							to="/$workspace/issue/$issueKey"
							params={{ workspace: slug, issueKey: key }}
							className={cn(
								"flex flex-col gap-0.5 rounded px-2 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
								overdue && "bg-destructive/10 text-destructive hover:bg-destructive/15",
							)}
						>
							<span className="flex min-w-0 items-center gap-1.5">
								<StatusIcon status={issue.status} className="size-3.5 shrink-0" />
								<span className="shrink-0 font-mono tabular-nums opacity-70">
									<span className="sr-only">{overdue ? "Overdue. " : ""}</span>
									{key}
								</span>
								<span className="truncate">{issue.title}</span>
							</span>
							<span className="pl-5 text-xs opacity-70">{describeDates(issue)}</span>
						</Link>
					</li>
				);
			})}
		</ul>
	);
}
