const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 60 * 60 * 1000],
	["month", 30 * 24 * 60 * 60 * 1000],
	["week", 7 * 24 * 60 * 60 * 1000],
	["day", 24 * 60 * 60 * 1000],
	["hour", 60 * 60 * 1000],
	["minute", 60 * 1000],
];

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 days ago", "yesterday", "just now". */
export function formatRelative(time: number, now = Date.now()): string {
	const elapsed = time - now;
	for (const [unit, size] of UNITS) {
		if (Math.abs(elapsed) >= size) return relative.format(Math.round(elapsed / size), unit);
	}
	return "just now";
}

const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const long = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Oct 27". */
export function formatShortDate(time: number): string {
	return short.format(time);
}

/** "Oct 27, 2026, 5:31 PM", for tooltips. */
export function formatDateTime(time: number): string {
	return long.format(time);
}

// Calendar days (`YYYY-MM-DD`), such as due dates: a day on the calendar, the same in every time
// zone, unlike the instants above. ISO days compare correctly as text.

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** "Dec 31, 2026" for a calendar day. */
export function formatDay(date: string): string {
	const parsed = parseDay(date);
	return parsed ? day.format(parsed) : date;
}

const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** "Thursday, December 31, 2026", for labels. */
export function formatFullDay(date: string): string {
	const parsed = parseDay(date);
	return parsed ? full.format(parsed) : date;
}

/** "Thu", for a column heading. */
export function formatWeekday(date: string): string {
	const parsed = parseDay(date);
	return parsed ? weekday.format(parsed) : date;
}

/** "Dec 31" for lists, with the year when it is not this year's. */
export function formatShortDay(date: string, now = new Date()): string {
	const parsed = parseDay(date);
	if (!parsed) return date;
	return parsed.getFullYear() === now.getFullYear() ? short.format(parsed) : day.format(parsed);
}

/** The day `now` falls on, as `YYYY-MM-DD` in the viewer's time zone. */
export function today(now = new Date()): string {
	return toDay(now);
}

/** The calendar day `days` after `date`. */
export function addDays(date: string, days: number): string {
	const parsed = parseDay(date);
	if (!parsed) return date;
	parsed.setDate(parsed.getDate() + days);
	return toDay(parsed);
}

/** A calendar day as a local-midnight `Date`, or null if it is malformed. */
export function parseDay(date: string): Date | null {
	const [year, month, dayOfMonth] = date.split("-").map(Number);
	if (!year || !month || !dayOfMonth) return null;
	return new Date(year, month - 1, dayOfMonth);
}

/** The `YYYY-MM-DD` of a local `Date`. */
export function toDay(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
