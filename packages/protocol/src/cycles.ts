import type { Cycle } from "./domain";

/** How many cycles a team with cycles on keeps scheduled after the one that is running. */
export const UPCOMING_CYCLES = 2;
export const MAX_CYCLE_WEEKS = 4;

/** Where a cycle stands on a given day. */
export type CycleState = "upcoming" | "current" | "completed";

/**
 * Where a cycle stands on `today`, a day in its team's time zone. A cycle whose last day is over
 * counts as completed even in the moment before the server completes it.
 */
export function cycleState(
	cycle: Pick<Cycle, "startsOn" | "endsOn" | "completedAt">,
	today: string,
): CycleState {
	if (cycle.completedAt !== null || cycle.endsOn < today) return "completed";
	return cycle.startsOn > today ? "upcoming" : "current";
}

/** The last day of a cycle that starts on `startsOn` and lasts `weeks` weeks. */
export function cycleEnd(startsOn: string, weeks: number): string {
	return addDays(startsOn, weeks * 7 - 1);
}

/** Whether this runtime knows `timeZone` as a time zone, such as `Europe/Istanbul`. */
export function isTimeZone(timeZone: string): boolean {
	try {
		formatter(timeZone);
		return true;
	} catch {
		return false;
	}
}

/** The calendar day it is at `at` (epoch ms) in `timeZone`, as `YYYY-MM-DD`. */
export function dayIn(timeZone: string, at: number): string {
	const { year, month, day } = clock(timeZone, at);
	return `${year}-${pad(month)}-${pad(day)}`;
}

/** The day `days` days after `day`, or before it when `days` is negative. */
export function addDays(day: string, days: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

/** How many days `to` is after `from`; negative when it is before. */
export function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * When `day` begins in `timeZone` (epoch ms). That is its midnight, or the first moment after it
 * where a change of offset skips midnight.
 */
export function startOfDay(timeZone: string, day: string): number {
	let at = atHour(timeZone, day, 0);
	// Where the clock jumps over midnight, the guess is still in the day before.
	while (dayIn(timeZone, at) < day) at += 15 * 60 * 1000;
	return at;
}

/**
 * When the clock in `timeZone` reads `hour`:00 on `day` (epoch ms). Where a change of offset
 * skips that time, a moment next to it.
 */
export function atHour(timeZone: string, day: string, hour: number): number {
	const wall = Date.parse(`${day}T${pad(hour)}:00:00Z`);
	// The offset at a guess decides the next guess. Two rounds settle a guess that lands on the
	// other side of a change of offset.
	const at = wall - offsetAt(timeZone, wall);
	return wall - offsetAt(timeZone, at);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Formatters are slow to make, and the same few time zones come up again and again. */
function formatter(timeZone: string): Intl.DateTimeFormat {
	let format = formatters.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hourCycle: "h23",
		});
		formatters.set(timeZone, format);
	}
	return format;
}

/** How the time zone's clock reads at `at`. */
function clock(timeZone: string, at: number) {
	const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
	for (const part of formatter(timeZone).formatToParts(at)) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return {
		year: parts.year ?? 0,
		month: parts.month ?? 1,
		day: parts.day ?? 1,
		hour: parts.hour ?? 0,
		minute: parts.minute ?? 0,
		second: parts.second ?? 0,
	};
}

/** How far the time zone's clock is ahead of UTC at `at`, in milliseconds. */
function offsetAt(timeZone: string, at: number): number {
	const { year, month, day, hour, minute, second } = clock(timeZone, at);
	const seconds = Math.floor(at / 1000) * 1000;
	return Date.UTC(year, month - 1, day, hour, minute, second) - seconds;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
