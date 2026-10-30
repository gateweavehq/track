import type { Issue } from "@gateweave/track-protocol";
import { addDays, parseDay, toDay } from "./dates";
import { compareIssues, LIST_STATUS_ORDER } from "./issues";

// The calendar layout's pure parts. A month is `YYYY-MM` and a day `YYYY-MM-DD`, both plain text
// so that nothing shifts with the viewer's time zone.

/** The month a day falls in. */
export function monthOf(day: string): string {
	return day.slice(0, 7);
}

/** The month `count` months after `month` (before, when negative). */
export function addMonths(month: string, count: number): string {
	const first = parseDay(`${month}-01`);
	if (!first) return month;
	return monthOf(toDay(new Date(first.getFullYear(), first.getMonth() + count, 1)));
}

/** "November 2026". */
export function formatMonth(month: string): string {
	const first = parseDay(`${month}-01`);
	return first ? MONTH.format(first) : month;
}

const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/** The weeks that show a month, Monday first: whole weeks of days, spilling into the neighbors. */
export function monthWeeks(month: string): string[][] {
	const first = parseDay(`${month}-01`);
	if (!first) return [];
	const last = toDay(new Date(first.getFullYear(), first.getMonth() + 1, 0));
	// getDay() counts from Sunday; shift so that Monday is 0.
	let start = addDays(`${month}-01`, -((first.getDay() + 6) % 7));
	const weeks: string[][] = [];
	while (start <= last) {
		weeks.push(Array.from({ length: 7 }, (_, index) => addDays(start, index)));
		start = addDays(start, 7);
	}
	return weeks;
}

/** Issues in the order of the list: by status group, then by manual order. */
function compareForCalendar(a: Issue, b: Issue): number {
	return (
		LIST_STATUS_ORDER.indexOf(a.status) - LIST_STATUS_ORDER.indexOf(b.status) || compareIssues(a, b)
	);
}

export interface DueDates {
	/** Issues by due date, each day's in list order. */
	byDay: Map<string, Issue[]>;
	/** How many issues have no due date, so are not on any day. */
	undated: number;
}

/** Groups issues by the day they are due. */
export function groupByDueDate(issues: readonly Issue[]): DueDates {
	const byDay = new Map<string, Issue[]>();
	let undated = 0;
	for (const issue of [...issues].sort(compareForCalendar)) {
		if (!issue.dueDate) {
			undated++;
			continue;
		}
		const day = byDay.get(issue.dueDate);
		if (day) day.push(issue);
		else byDay.set(issue.dueDate, [issue]);
	}
	return { byDay, undated };
}

/** The days of a month that have issues, earliest first, for the agenda. */
export function agendaDays(month: string, byDay: ReadonlyMap<string, readonly Issue[]>): string[] {
	return [...byDay.keys()].filter((day) => monthOf(day) === month).sort();
}
