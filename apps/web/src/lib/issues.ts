import {
	CLOSED_STATUSES,
	type DueFilter,
	type Issue,
	type IssueStatus,
	type Team,
} from "@gateweave/track-protocol";
import { generateKeyBetween } from "fractional-indexing";
import { addDays, today } from "./dates";

/** The human-readable identifier of an issue, e.g. `ENG-42`. */
export function issueKey(team: Pick<Team, "key"> | undefined, issue: Pick<Issue, "number">) {
	return `${team?.key ?? "?"}-${issue.number}`;
}

/** Parses `ENG-42` (in any case) into its team key and number. */
export function parseIssueKey(value: string): { teamKey: string; number: number } | null {
	const match = /^([A-Za-z][A-Za-z0-9]{0,6})-([1-9][0-9]{0,8})$/.exec(value.trim());
	if (!match?.[1] || !match[2]) return null;
	return { teamKey: match[1].toUpperCase(), number: Number(match[2]) };
}

/** The order of status groups in a list: work in flight first, finished work last. */
export const LIST_STATUS_ORDER = [
	"in_progress",
	"in_review",
	"todo",
	"backlog",
	"done",
	"canceled",
] as const satisfies readonly IssueStatus[];

/** The order of columns on a board: the workflow, left to right. */
export const BOARD_STATUS_ORDER = [
	"backlog",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"canceled",
] as const satisfies readonly IssueStatus[];

/** Manual order, with the id as a tiebreaker so concurrent inserts still sort the same everywhere. */
export function compareIssues(a: Issue, b: Issue): number {
	if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface StatusGroup {
	status: IssueStatus;
	issues: Issue[];
}

/** Groups issues by status, in the given order. Every status gets a group, even an empty one. */
export function groupByStatus(
	issues: readonly Issue[],
	order: readonly IssueStatus[] = LIST_STATUS_ORDER,
): StatusGroup[] {
	const groups = new Map<IssueStatus, Issue[]>(order.map((status) => [status, []]));
	for (const issue of issues) groups.get(issue.status)?.push(issue);
	return order.map((status) => ({
		status,
		issues: (groups.get(status) ?? []).sort(compareIssues),
	}));
}

/** A sort order that places a new issue after every existing one. */
export function sortOrderAfter(issues: Iterable<Pick<Issue, "sortOrder">>): string {
	let last: string | null = null;
	for (const issue of issues) {
		if (last === null || issue.sortOrder > last) last = issue.sortOrder;
	}
	return generateKeyBetween(last, null);
}

/**
 * A sort order that places an issue at `index` in `sorted`, a list in display order that does
 * not contain the issue. Issues that share a sort order (two people added them at the same
 * moment) have no room between them, so the issue goes after all of them.
 */
export function sortOrderAt(sorted: readonly Pick<Issue, "sortOrder">[], index: number): string {
	const before = sorted[index - 1]?.sortOrder ?? null;
	const after =
		sorted.slice(Math.max(index, 0)).find((issue) => before === null || issue.sortOrder > before)
			?.sortOrder ?? null;
	return generateKeyBetween(before, after);
}

/**
 * What changes when `issue` moves to `index` among the issues of `status`. `group` holds that
 * status's issues in display order and may include the issue itself; `index` counts positions
 * without it. Returns null when the issue would end up where it already is.
 */
export function planMove(
	group: readonly Issue[],
	issue: Issue,
	status: IssueStatus,
	index: number,
): { status?: IssueStatus; sortOrder: string } | null {
	const fields: { status?: IssueStatus } = status === issue.status ? {} : { status };
	return planPlacement(group, issue, index, fields);
}

/**
 * What changes when `issue` is placed at `index` among `group`, the issues of one group in
 * manual order, which may include the issue itself. `fields` are what moving into the group
 * changes about the issue (none when it is already there). Returns null when nothing would change.
 */
export function planPlacement<F extends object>(
	group: readonly Issue[],
	issue: Issue,
	index: number,
	fields: F,
): (F & { sortOrder: string }) | null {
	const others = group.filter((other) => other.id !== issue.id);
	const target = Math.min(Math.max(index, 0), others.length);
	const unchanged = Object.keys(fields).length === 0;
	if (unchanged && group.findIndex((other) => other.id === issue.id) === target) return null;
	return { ...fields, sortOrder: sortOrderAt(others, target) };
}

/**
 * True if every whitespace-separated term in the query appears in at least one of the fields,
 * ignoring case. An empty query matches everything.
 */
export function matchesQuery(query: string, ...fields: readonly string[]): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const haystack = fields.map((field) => field.toLowerCase());
	return terms.every((term) => haystack.some((field) => field.includes(term)));
}

/** The estimates offered when picking one, in points. Agents can set any whole number to 1,000. */
export const ESTIMATE_OPTIONS = [1, 2, 3, 5, 8, 13, 21] as const;

/** "1 point", "5 points". */
export function estimateLabel(points: number): string {
	return points === 1 ? "1 point" : `${points} points`;
}

/** True when an open issue's due date has passed. Done and canceled issues are never overdue. */
export function isIssueOverdue(
	issue: Pick<Issue, "dueDate" | "status">,
	now = new Date(),
): boolean {
	return (
		issue.dueDate !== null && issue.dueDate < today(now) && !CLOSED_STATUSES.includes(issue.status)
	);
}

// Defined with the other filters in the protocol, since saved views store them.
export { DUE_FILTERS, type DueFilter } from "@gateweave/track-protocol";

export const DUE_FILTER_LABELS: Record<DueFilter, string> = {
	overdue: "Overdue",
	week: "Due within a week",
	none: "No due date",
};

/**
 * Whether an issue passes a due-date filter: overdue, due today or in the next six days (open
 * issues only, like overdue), or without a due date.
 */
export function matchesDue(
	issue: Pick<Issue, "dueDate" | "status">,
	filter: DueFilter,
	now = new Date(),
): boolean {
	if (filter === "none") return issue.dueDate === null;
	if (filter === "overdue") return isIssueOverdue(issue, now);
	const day = today(now);
	return (
		issue.dueDate !== null &&
		issue.dueDate >= day &&
		issue.dueDate <= addDays(day, 6) &&
		!CLOSED_STATUSES.includes(issue.status)
	);
}
