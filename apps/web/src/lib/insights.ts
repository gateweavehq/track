import {
	type Activity,
	addDays,
	dayIn,
	daysBetween,
	type Issue,
	isClosedCategory,
	type StatusCategory,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import { type StatusMap, statusOf, teamStatuses } from "./statuses";

// Insights into a team's or a project's issues, worked out from the local copy: nothing here asks the server, so they show
// offline and cost the Durable Object nothing. Closing and starting are read from issue history
// (status changes), which the copy holds whole; an issue's status names a status of its team,
// and a removed status keeps its row, so old keys still resolve to their category.

/** How far back the insights look, in weeks. */
export const INSIGHT_RANGES = [4, 12, 26] as const;
export type InsightRange = (typeof INSIGHT_RANGES)[number];

export interface InsightWeek {
	/** The week's Monday, `YYYY-MM-DD` in the time zone the insights are worked out in. */
	start: string;
	created: number;
	/** Issues closed (completed or canceled) that week. */
	closed: number;
}

export interface InsightCount<T> {
	key: T;
	count: number;
}

/** What insights say about any set of issues, a team's or a project's. */
export interface Insights {
	/** Oldest first, the last one being the week that is not over. */
	weeks: InsightWeek[];
	/** Over the whole range. */
	created: number;
	closed: number;
	/** Of the issues completed in the range: from when work started on each to when it was done. */
	cycleTime: { medianDays: number | null; issues: number };
	/** Issues that are open now. */
	open: number;
	/** Open issues by team id, the most first. */
	byTeam: InsightCount<string>[];
	/** Open issues by assignee id, null for no one, the most first. */
	byAssignee: InsightCount<string | null>[];
	/** Open issues by label id, the most first. An issue counts under each of its labels. */
	byLabel: InsightCount<string>[];
}

export interface TeamInsights extends Insights {
	/** Open issues by status, in the team's order. Statuses with none are left out. */
	byStatus: InsightCount<WorkflowStatus>[];
}

interface InsightOptions {
	issues: Iterable<Issue>;
	activities: Iterable<Activity>;
	statuses: StatusMap;
	timeZone: string;
	now: number;
	weeks: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A team's insights over the last `weeks` weeks, this one included. Archived issues count:
 * archiving takes an issue out of lists, not out of what the team did.
 */
export function teamInsights({
	teamId,
	issues,
	statuses,
	...options
}: InsightOptions & { teamId: string }): TeamInsights {
	const insights = insightsOf({
		...options,
		statuses,
		issues: [...issues].filter((issue) => issue.teamId === teamId),
	});
	const order = teamStatuses(statuses, teamId);
	const byStatusKey = countBy(insights.openIssues, (issue) => [issue.status]);
	const byStatus = order.flatMap((status) => {
		const count = byStatusKey.get(status.key) ?? 0;
		return count > 0 ? [{ key: status, count }] : [];
	});
	// An issue in a status the copy does not list yet still counts, after the known ones.
	for (const [key, count] of byStatusKey) {
		if (!order.some((status) => status.key === key)) {
			byStatus.push({ key: statusOf(statuses, { teamId, status: key }), count });
		}
	}
	const { openIssues: _, ...rest } = insights;
	return { ...rest, byStatus };
}

/**
 * A project's insights over the last `weeks` weeks: of the issues in it now, from any team, the
 * archived ones too. An issue moved out of the project takes its history with it.
 */
export function projectInsights({
	projectId,
	issues,
	...options
}: InsightOptions & { projectId: string }): Insights {
	const { openIssues: _, ...insights } = insightsOf({
		...options,
		issues: [...issues].filter((issue) => issue.projectId === projectId),
	});
	return insights;
}

function insightsOf({
	issues,
	activities,
	statuses,
	timeZone,
	now,
	weeks: count,
}: InsightOptions): Insights & { openIssues: Issue[] } {
	// History names statuses by key, which each team has its own of.
	const categoryOf = (issue: Issue, status: string): StatusCategory =>
		statusOf(statuses, { teamId: issue.teamId, status }).category;
	const first = addDays(weekStart(dayIn(timeZone, now)), -7 * (count - 1));
	const weeks: InsightWeek[] = Array.from({ length: count }, (_, index) => ({
		start: addDays(first, index * 7),
		created: 0,
		closed: 0,
	}));
	const weekOf = (time: number): InsightWeek | undefined => {
		if (time > now) return undefined;
		const day = dayIn(timeZone, time);
		if (day < first) return undefined;
		return weeks[Math.floor(daysBetween(first, day) / 7)];
	};

	const scope = [...issues];
	const ids = new Set(scope.map((issue) => issue.id));
	const histories = new Map<string, Activity[]>();
	for (const activity of activities) {
		if (activity.change.type !== "status" || !ids.has(activity.issueId)) continue;
		const history = histories.get(activity.issueId);
		if (history) history.push(activity);
		else histories.set(activity.issueId, [activity]);
	}

	const cycleTimes: number[] = [];
	const open: Issue[] = [];
	for (const issue of scope) {
		const created = weekOf(issue.createdAt);
		if (created) created.created += 1;
		if (!isClosedCategory(categoryOf(issue, issue.status))) open.push(issue);

		// A merged entry says where a change ended up, as of its last update.
		const history = (histories.get(issue.id) ?? []).sort((a, b) => a.updatedAt - b.updatedAt);
		// An issue filed straight into a closed status, as an import or a note of done work does,
		// was closed when it was created.
		const firstStatus =
			history[0]?.change.type === "status" ? history[0].change.from : issue.status;
		if (isClosedCategory(categoryOf(issue, firstStatus)) && created) created.closed += 1;
		// Likewise, one filed straight into a started status, from the create dialog or over MCP,
		// was started when it was created.
		let started: number | null =
			categoryOf(issue, firstStatus) === "started" ? issue.createdAt : null;
		let completed: number | null = null;
		for (const entry of history) {
			if (entry.change.type !== "status") continue;
			const from = categoryOf(issue, entry.change.from);
			const to = categoryOf(issue, entry.change.to);
			if (to === "started" && started === null) started = entry.updatedAt;
			// Reopening and closing again counts again: the team closed it twice.
			if (!isClosedCategory(from) && isClosedCategory(to)) {
				const closed = weekOf(entry.updatedAt);
				if (closed) closed.closed += 1;
			}
			// Moving between two completed statuses keeps when it was done; leaving them undoes it.
			if (to !== "completed") completed = null;
			else if (from !== "completed" || completed === null) completed = entry.updatedAt;
		}
		// Done, still, and done in the range: from the first start to the last completion.
		if (
			completed !== null &&
			started !== null &&
			started <= completed &&
			categoryOf(issue, issue.status) === "completed" &&
			weekOf(completed)
		) {
			cycleTimes.push((completed - started) / DAY);
		}
	}

	return {
		weeks,
		created: weeks.reduce((sum, week) => sum + week.created, 0),
		closed: weeks.reduce((sum, week) => sum + week.closed, 0),
		cycleTime: { medianDays: median(cycleTimes), issues: cycleTimes.length },
		open: open.length,
		openIssues: open,
		byTeam: ranked(countBy(open, (issue) => [issue.teamId])),
		byAssignee: ranked(countBy(open, (issue) => [issue.assigneeId])),
		byLabel: ranked(countBy(open, (issue) => issue.labelIds)),
	};
}

/** The Monday on or before `day`. */
export function weekStart(day: string): string {
	const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
	const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
	return addDays(day, -((weekday + 6) % 7));
}

/**
 * A duration in days as people say it: under an hour, then hours under a day, then days to one
 * decimal. Rounding fast work up to an hour would overstate it.
 */
export function formatDays(days: number): string {
	if (days * 24 < 1) return "under an hour";
	if (days < 1) {
		const hours = Math.max(1, Math.round(days * 24));
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	const rounded = days < 10 ? Math.round(days * 10) / 10 : Math.round(days);
	return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

function countBy<T>(
	issues: readonly Issue[],
	keys: (issue: Issue) => readonly T[],
): Map<T, number> {
	const counts = new Map<T, number>();
	for (const issue of issues) {
		for (const key of new Set(keys(issue))) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** The most first; ties keep the order they were met in. */
function ranked<T>(counts: ReadonlyMap<T, number>): InsightCount<T>[] {
	return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const upper = sorted[middle] ?? 0;
	return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}
