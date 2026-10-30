import type { Issue } from "@gateweave/track-protocol";
import { addDays, parseDay } from "./dates";
import { compareIssues } from "./issues";

// The timeline layout's pure parts. Days are `YYYY-MM-DD` text, so nothing shifts with the
// viewer's time zone, and ISO days compare correctly as text.

/** Days on the chart at once: twelve weeks. */
export const WINDOW_DAYS = 84;

/** How far Previous and Next move the window, in days. */
export const WINDOW_STEP = 28;

/** The Monday of the week a day falls in. */
export function weekStart(day: string): string {
	const parsed = parseDay(day);
	// getDay() counts from Sunday; shift so that Monday is 0.
	return parsed ? addDays(day, -((parsed.getDay() + 6) % 7)) : day;
}

/**
 * Where the window starts when the chart opens: the week before today's, so that a bar that
 * just ended or an issue that just went overdue is still in view next to today.
 */
export function initialWindowStart(now: string): string {
	return addDays(weekStart(now), -7);
}

/** The days of the window that starts on `start`. */
export function windowDays(start: string, count = WINDOW_DAYS): string[] {
	return Array.from({ length: count }, (_, index) => addDays(start, index));
}

/** Whether a day is a Saturday or a Sunday. */
export function isWeekend(day: string): boolean {
	const weekday = parseDay(day)?.getDay();
	return weekday === 0 || weekday === 6;
}

/** A run of days of the window in one month, for the header above the day numbers. */
export interface MonthSpan {
	month: string;
	/** Index of the month's first day in the window. */
	first: number;
	/** Days of the month in the window. */
	count: number;
}

export function monthSpans(days: readonly string[]): MonthSpan[] {
	const spans: MonthSpan[] = [];
	days.forEach((day, index) => {
		const month = day.slice(0, 7);
		const last = spans[spans.length - 1];
		if (last?.month === month) last.count += 1;
		else spans.push({ month, first: index, count: 1 });
	});
	return spans;
}

/** The days an issue occupies. An issue with one date occupies that day alone. */
export interface Dates {
	startDate: string | null;
	dueDate: string | null;
}

export interface Span {
	start: string;
	end: string;
}

/** The first and last day of an issue's bar, or null if it has no date. */
export function issueSpan({ startDate, dueDate }: Dates): Span | null {
	const start = startDate ?? dueDate;
	const end = dueDate ?? startDate;
	if (start === null || end === null) return null;
	// Dates are validated on the server, but a bar must never run backwards if one gets through.
	return start <= end ? { start, end } : { start: end, end: start };
}

export interface TimelineRow {
	issue: Issue;
	span: Span;
	/** Only one of the dates is set, so the other end of the bar is not known. */
	openEnded: boolean;
}

/**
 * Issues with a start date or a due date, the earliest start first, and how many have neither.
 * Ties fall back to the due date and then to the list's own order, so rows do not jump around.
 */
export function timelineRows(issues: readonly Issue[]): { rows: TimelineRow[]; undated: number } {
	const rows: TimelineRow[] = [];
	let undated = 0;
	for (const issue of issues) {
		const span = issueSpan(issue);
		if (!span) undated += 1;
		else rows.push({ issue, span, openEnded: issue.startDate === null || issue.dueDate === null });
	}
	rows.sort(
		(a, b) =>
			compareDays(a.span.start, b.span.start) ||
			compareDays(a.span.end, b.span.end) ||
			compareIssues(a.issue, b.issue),
	);
	return { rows, undated };
}

function compareDays(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A bar's columns in the window, both ends included, counted from 0. */
export interface BarColumns {
	first: number;
	last: number;
	/** The bar goes on before the window's first day. */
	cutStart: boolean;
	/** The bar goes on after the window's last day. */
	cutEnd: boolean;
}

/** A span's columns clipped to the window, or null if it is entirely outside it. */
export function barColumns(
	span: Span,
	windowStart: string,
	count = WINDOW_DAYS,
): BarColumns | null {
	const windowEnd = addDays(windowStart, count - 1);
	if (span.end < windowStart || span.start > windowEnd) return null;
	const cutStart = span.start < windowStart;
	const cutEnd = span.end > windowEnd;
	return {
		first: cutStart ? 0 : daysBetween(windowStart, span.start),
		last: cutEnd ? count - 1 : daysBetween(windowStart, span.end),
		cutStart,
		cutEnd,
	};
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
	const a = parseDay(from);
	const b = parseDay(to);
	if (!a || !b) return 0;
	// Counting in UTC keeps a daylight saving change from making a day 23 or 25 hours long.
	return Math.round(
		(Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
			Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
			86_400_000,
	);
}

/** What a drag grabs: the whole bar, or its left or right edge. */
export type DragMode = "move" | "start" | "end";

/**
 * The fields to write when a drag of `days` ends: a move shifts every date the issue has, an edge
 * changes only its own date and stops at the other one. Null when nothing changes. An issue with
 * one date is moved without gaining the other; dragging an edge is how it gets a second date.
 */
export function dragPatch(
	dates: Dates,
	mode: DragMode,
	days: number,
): { startDate?: string; dueDate?: string } | null {
	const span = issueSpan(dates);
	if (!span || days === 0) return null;
	if (mode === "move") {
		const patch: { startDate?: string; dueDate?: string } = {};
		if (dates.startDate !== null) patch.startDate = addDays(dates.startDate, days);
		if (dates.dueDate !== null) patch.dueDate = addDays(dates.dueDate, days);
		return patch;
	}
	if (mode === "start") {
		const start = minDay(addDays(span.start, days), span.end);
		return start === span.start ? null : { startDate: start };
	}
	const end = maxDay(addDays(span.end, days), span.start);
	return end === span.end ? null : { dueDate: end };
}

/** The dates an issue shows while a drag is under way. */
export function draggedDates(dates: Dates, mode: DragMode, days: number): Dates {
	return { ...dates, ...dragPatch(dates, mode, days) };
}

function minDay(a: string, b: string): string {
	return a < b ? a : b;
}

function maxDay(a: string, b: string): string {
	return a > b ? a : b;
}
