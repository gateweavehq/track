import {
	type Activity,
	addDays,
	type Cycle,
	type CycleState,
	cycleState,
	dayIn,
	daysBetween,
	type Issue,
	startOfDay,
	type Team,
} from "@gateweave/track-protocol";

// Cycles as pages show them. The server dates, makes and completes them; here they are only read.
// "Today" is the day in the team's time zone, which is when the server moves cycles on.

/** What a cycle is called: the name people gave it, or "Cycle" and its number. */
export function cycleName(cycle: Pick<Cycle, "name" | "number">): string {
	return cycle.name ?? `Cycle ${cycle.number}`;
}

/** The browser's time zone, which a team's cycles start in unless an admin picks another. */
export function localZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The time zone a team's cycles run in, or the browser's for a team without cycles. */
export function teamZone(team: Pick<Team, "cycles"> | undefined): string {
	return team?.cycles?.timeZone ?? localZone();
}

/** Where a cycle of `team` stands now. */
export function stateIn(
	cycle: Cycle,
	team: Pick<Team, "cycles"> | undefined,
	now: number,
): CycleState {
	return cycleState(cycle, dayIn(teamZone(team), now));
}

/** Where a cycle stands now, its team looked up in `teams`. */
export function stateOf(
	cycle: Cycle,
	teams: ReadonlyMap<string, Pick<Team, "cycles">>,
	now: number,
): CycleState {
	return stateIn(cycle, teams.get(cycle.teamId), now);
}

/** Each team's current and next cycles, which the `current` and `next` filters stand for. */
export interface RelativeCycles {
	current: ReadonlySet<string>;
	next: ReadonlySet<string>;
}

export const NO_RELATIVE_CYCLES: RelativeCycles = { current: new Set(), next: new Set() };

export function relativeCycles(
	cycles: Iterable<Cycle>,
	teams: ReadonlyMap<string, Pick<Team, "cycles">>,
	now: number,
): RelativeCycles {
	const current = new Set<string>();
	const next = new Map<string, Cycle>();
	for (const cycle of cycles) {
		const state = stateOf(cycle, teams, now);
		if (state === "current") current.add(cycle.id);
		if (state !== "upcoming") continue;
		const earliest = next.get(cycle.teamId);
		if (!earliest || cycle.number < earliest.number) next.set(cycle.teamId, cycle);
	}
	return { current, next: new Set([...next.values()].map((cycle) => cycle.id)) };
}

/** How a cycle's work stands: issues and points, done and in all. Canceled issues do not count. */
export interface CycleProgress {
	issues: { done: number; total: number };
	points: { done: number; total: number };
}

export function cycleProgress(issues: Iterable<Issue>): CycleProgress {
	const progress: CycleProgress = { issues: { done: 0, total: 0 }, points: { done: 0, total: 0 } };
	for (const issue of issues) {
		if (issue.status === "canceled") continue;
		const points = issue.estimate ?? 0;
		progress.issues.total += 1;
		progress.points.total += points;
		if (issue.status === "done") {
			progress.issues.done += 1;
			progress.points.done += points;
		}
	}
	return progress;
}

/** One day of a burn-up: the issues in the cycle as the day ended, and how many were done. */
export interface BurnUpDay {
	day: string;
	scope: number;
	done: number;
}

/**
 * A cycle's burn-up, from its first day to its last, or to today while it runs. It is worked out
 * from issue history: when each issue joined or left the cycle, and how its status changed. An
 * issue with no history of either has been as it is since it was made. Canceled issues leave the
 * scope, as they leave the cycle's progress.
 */
export function burnUp(
	cycle: Cycle,
	issues: Iterable<Issue>,
	activities: Iterable<Activity>,
	timeZone: string,
	now: number,
): BurnUpDay[] {
	const today = dayIn(timeZone, now);
	const end = cycle.completedAt !== null || today > cycle.endsOn ? cycle.endsOn : today;
	const length = daysBetween(cycle.startsOn, end) + 1;
	if (length <= 0) return [];
	// A cycle that completed is seen as it was just before: completing moves its unfinished issues
	// out, at once when its team stops working in cycles before its last day is over.
	const until = cycle.completedAt === null ? now : Math.min(now, cycle.completedAt - 1);
	const days = Array.from({ length }, (_, index) => {
		const day = addDays(cycle.startsOn, index);
		// Its last moment, or now for the day that is not over.
		const at = Math.min(startOfDay(timeZone, addDays(day, 1)) - 1, until);
		return { day, at, scope: 0, done: 0 };
	});

	// What happened to each issue, in order. A merged entry says where a change ended up, as of
	// its last update.
	const histories = new Map<string, Activity[]>();
	for (const activity of activities) {
		const { change } = activity;
		const relevant =
			change.type === "status" ||
			(change.type === "cycle" && (change.from === cycle.id || change.to === cycle.id));
		if (!relevant) continue;
		const history = histories.get(activity.issueId);
		if (history) history.push(activity);
		else histories.set(activity.issueId, [activity]);
	}

	for (const issue of issues) {
		const history = (histories.get(issue.id) ?? []).sort((a, b) => a.updatedAt - b.updatedAt);
		const moves = history.flatMap((entry) => (entry.change.type === "cycle" ? [entry.change] : []));
		const statuses = history.flatMap((entry) =>
			entry.change.type === "status" ? [entry.change] : [],
		);
		const first = moves[0];
		let inCycle = first ? first.from === cycle.id : issue.cycleId === cycle.id;
		if (!inCycle && !first) continue;
		let status = statuses[0]?.from ?? issue.status;

		let next = 0;
		for (const slot of days) {
			if (slot.at < issue.createdAt) continue;
			for (; next < history.length; next += 1) {
				const entry = history[next];
				if (!entry || entry.updatedAt > slot.at) break;
				if (entry.change.type === "cycle") inCycle = entry.change.to === cycle.id;
				else if (entry.change.type === "status") status = entry.change.to;
			}
			if (!inCycle || status === "canceled") continue;
			slot.scope += 1;
			if (status === "done") slot.done += 1;
		}
	}
	return days.map(({ day, scope, done }) => ({ day, scope, done }));
}

/** The coming Monday, or `day` itself when it is one: where a team's cycles start at first. */
export function nextMonday(day: string): string {
	const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
	const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
	return addDays(day, (8 - weekday) % 7);
}

/** The cycles of one team that have not completed, the one running today (if any), and the next. */
function openCyclesOf(cycles: readonly Cycle[], today: string) {
	const open = cycles
		.filter((cycle) => cycle.completedAt === null)
		.sort((a, b) => a.number - b.number);
	return {
		running: open.filter((cycle) => cycle.startsOn <= today).at(-1),
		upcoming: open.find((cycle) => cycle.startsOn > today),
	};
}

/**
 * The first day an admin's settings start the next cycle on, as they open: where the next cycle
 * starts now, else the day after the running one ends, else the coming Monday.
 */
export function suggestedStart(cycles: readonly Cycle[], today: string): string {
	const { running, upcoming } = openCyclesOf(cycles, today);
	if (upcoming) return upcoming.startsOn;
	return running ? addDays(running.endsOn, 1) : nextMonday(today);
}

/** The earliest day the next cycle may start on: after the running cycle, if one runs. */
export function earliestStart(cycles: readonly Cycle[], today: string): string | null {
	const { running } = openCyclesOf(cycles, today);
	return running ? addDays(running.endsOn, 1) : null;
}

/** Why the server would turn down these settings, as it words it, or null if it would not. */
export function startProblem(
	cycles: readonly Cycle[],
	today: string,
	startsOn: string,
	weeks: number,
): string | null {
	const earliest = earliestStart(cycles, today);
	if (earliest && startsOn < earliest) {
		return `The next cycle has to start after the current one ends: on ${earliest} or later`;
	}
	if (!earliest && daysBetween(startsOn, today) >= weeks * 7) {
		return "A cycle that starts then would be over already";
	}
	if (daysBetween(today, startsOn) > 366) return "Cycles can start at most a year ahead";
	return null;
}
