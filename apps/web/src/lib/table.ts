import {
	type Cycle,
	ISSUE_STATUSES,
	type Issue,
	type Member,
	type Project,
	type SortColumn,
	type SortDirection,
	type Team,
} from "@gateweave/track-protocol";
import { PRIORITY_ORDER } from "#/components/issues/meta";
import { compareIssues } from "./issues";

// The table's columns and sort are display options (`IssueDisplay` in the protocol), so they are
// kept in the URL and in saved views; see `display.ts`.
export type { SortColumn, SortDirection };
export interface TableSort {
	column: SortColumn;
	direction: SortDirection;
}

/** What names the things an issue points to. */
export interface SortLookups {
	teams: ReadonlyMap<string, Pick<Team, "key">>;
	members: ReadonlyMap<string, Pick<Member, "name">>;
	projects: ReadonlyMap<string, Pick<Project, "name">>;
	cycles: ReadonlyMap<string, Pick<Cycle, "startsOn">>;
}

type SortValue = string | number | null;

const STATUS_RANK = new Map<string, number>(ISSUE_STATUSES.map((status, index) => [status, index]));
const PRIORITY_RANK = new Map<number, number>(
	PRIORITY_ORDER.map((priority, index) => [priority, index]),
);

/** The value a column sorts by. `null` is an empty value, which sorts last in both directions. */
function sortValue(issue: Issue, column: SortColumn, lookups: SortLookups): SortValue {
	switch (column) {
		case "id": {
			// The key as text would put ENG-10 before ENG-9.
			const team = lookups.teams.get(issue.teamId)?.key ?? "?";
			return `${team}\u0000${String(issue.number).padStart(12, "0")}`;
		}
		case "title":
			return issue.title;
		case "status":
			return STATUS_RANK.get(issue.status) ?? null;
		case "priority":
			// "No priority" is empty: it should not lead when the order is reversed.
			return issue.priority === 0 ? null : (PRIORITY_RANK.get(issue.priority) ?? null);
		case "assignee":
			return (issue.assigneeId && lookups.members.get(issue.assigneeId)?.name) || null;
		case "project":
			return (issue.projectId && lookups.projects.get(issue.projectId)?.name) || null;
		case "cycle":
			// Earliest first: each team numbers its own cycles, but days are the same for all.
			return (issue.cycleId && lookups.cycles.get(issue.cycleId)?.startsOn) || null;
		case "estimate":
			return issue.estimate;
		case "startDate":
			return issue.startDate;
		case "dueDate":
			return issue.dueDate;
		case "created":
			return issue.createdAt;
		case "updated":
			return issue.updatedAt;
	}
}

function compareValues(a: string | number, b: string | number): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

/**
 * Issues in the order of a column, or in manual order (the list's) with no sort. Empty values go
 * last whichever way it runs, and ties keep manual order. Returns a new array.
 */
export function sortIssues(
	issues: readonly Issue[],
	sort: TableSort | null,
	lookups: SortLookups,
): Issue[] {
	if (!sort) return [...issues].sort(compareIssues);
	const sign = sort.direction === "asc" ? 1 : -1;
	// Compute each value once; a sort would otherwise look it up on every comparison.
	const values = new Map(issues.map((issue) => [issue.id, sortValue(issue, sort.column, lookups)]));
	return [...issues].sort((a, b) => {
		const left = values.get(a.id) ?? null;
		const right = values.get(b.id) ?? null;
		if (left === null || right === null) {
			if (left !== right) return left === null ? 1 : -1;
			return compareIssues(a, b);
		}
		return sign * compareValues(left, right) || compareIssues(a, b);
	});
}

/** The sort after a click on a column: ascending first, then it reverses with every click. */
export function nextSort(current: TableSort | null, column: SortColumn): TableSort {
	if (current?.column !== column) return { column, direction: "asc" };
	return { column, direction: current.direction === "asc" ? "desc" : "asc" };
}
