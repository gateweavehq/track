import type { Issue, IssueStatus, Team } from "@tangent/protocol";
import { generateKeyBetween } from "fractional-indexing";

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

/** Manual order, with the id as a tiebreaker so concurrent inserts still sort the same everywhere. */
export function compareIssues(a: Issue, b: Issue): number {
	if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface StatusGroup {
	status: IssueStatus;
	issues: Issue[];
}

/** Groups issues by status in list order. Every status gets a group, even an empty one. */
export function groupByStatus(issues: readonly Issue[]): StatusGroup[] {
	const groups = new Map<IssueStatus, Issue[]>(LIST_STATUS_ORDER.map((status) => [status, []]));
	for (const issue of issues) groups.get(issue.status)?.push(issue);
	return LIST_STATUS_ORDER.map((status) => ({
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
 * True if every whitespace-separated term in the query appears in at least one of the fields,
 * ignoring case. An empty query matches everything.
 */
export function matchesQuery(query: string, ...fields: readonly string[]): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const haystack = fields.map((field) => field.toLowerCase());
	return terms.every((term) => haystack.some((field) => field.includes(term)));
}
