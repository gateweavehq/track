import { addDays, daysBetween } from "./cycles";

// Repeating templates: a template on a schedule makes an issue on each day the schedule falls
// on, at the start of that day in the schedule's time zone. The days are counted from the first,
// so "every month from January 31" falls on the last day of shorter months and back on the 31st
// after them, instead of drifting.

export const REPEAT_UNITS = ["day", "week", "month"] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];

/** The most units a schedule waits between issues: every 99 days, weeks or months. */
export const MAX_REPEAT_EVERY = 99;

export interface TemplateRepeat {
	/** How many units apart the issues are, from 1 to {@link MAX_REPEAT_EVERY}. */
	every: number;
	unit: RepeatUnit;
	/** The first day the template makes an issue, as `YYYY-MM-DD` in `timeZone`. */
	startsOn: string;
	/** The IANA time zone, such as `Europe/Istanbul`, whose midnights the issues are made at. */
	timeZone: string;
}

type Schedule = Pick<TemplateRepeat, "every" | "unit" | "startsOn">;

/** The first day on or after `from` that the schedule falls on. */
export function nextRepeatDay(repeat: Schedule, from: string): string {
	const { every, unit, startsOn } = repeat;
	if (from <= startsOn) return startsOn;
	if (unit === "month") {
		// The count of whole steps before `from`, then forward to the first day not before it. A
		// short month can pull a day back, so the count may be one short, never over.
		let n = Math.max(0, Math.floor((monthIndex(from) - monthIndex(startsOn)) / every) - 1);
		while (monthDay(startsOn, n * every) < from) n += 1;
		return monthDay(startsOn, n * every);
	}
	const step = unit === "week" ? every * 7 : every;
	return addDays(startsOn, Math.ceil(daysBetween(startsOn, from) / step) * step);
}

/** The day `months` months after `day`, or the last day of that month when it is shorter. */
function monthDay(day: string, months: number): string {
	const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
	const index = year * 12 + (month - 1) + months;
	const targetYear = Math.floor(index / 12);
	const targetMonth = index % 12;
	const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
	return [
		String(targetYear).padStart(4, "0"),
		String(targetMonth + 1).padStart(2, "0"),
		String(Math.min(date, last)).padStart(2, "0"),
	].join("-");
}

function monthIndex(day: string): number {
	const [year = 0, month = 1] = day.split("-").map(Number);
	return year * 12 + (month - 1);
}
