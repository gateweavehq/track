import {
	DUE_FILTERS,
	type Issue,
	type IssueFilterKey,
	type IssueFilters,
	RELATIVE_CYCLES,
} from "@gateweave/track-protocol";
import { NO_RELATIVE_CYCLES, type RelativeCycles } from "./cycles";
import { matchesDue } from "./issues";

// Filters for pages of issues and saved views (`IssueFilters` in the protocol). They are applied
// to the local replica, so filtering is instant and works offline.

/** What a filter's ids can point to. Anything else has gone since the filter was made. */
export interface FilterTargets {
	teams: ReadonlyMap<string, unknown>;
	members: ReadonlyMap<string, unknown>;
	projects: ReadonlyMap<string, unknown>;
	cycles: ReadonlyMap<string, unknown>;
	labels: ReadonlyMap<string, unknown>;
}

const isRelativeCycle = (value: string | null) =>
	RELATIVE_CYCLES.some((relative) => relative === value);

/**
 * The filters that still mean something: values that resolve, without repeats. A property whose
 * values all went (a deleted label, say) is dropped rather than matching nothing, as a link or a
 * saved view should still show issues after a label is deleted.
 */
export function activeFilters(filters: IssueFilters, targets: FilterTargets): IssueFilters {
	return compactFilters({
		teamIds: kept(filters.teamIds, (id) => targets.teams.has(id)),
		statuses: kept(filters.statuses),
		priorities: kept(filters.priorities),
		assigneeIds: kept(filters.assigneeIds, (id) => id === null || targets.members.has(id)),
		projectIds: kept(filters.projectIds, (id) => id === null || targets.projects.has(id)),
		cycles: kept(
			filters.cycles,
			(id) => id === null || isRelativeCycle(id) || targets.cycles.has(id),
		),
		labelIds: kept(filters.labelIds, (id) => targets.labels.has(id)),
		due: filters.due,
	});
}

function kept<T>(values: readonly T[] | undefined, resolves: (value: T) => boolean = () => true) {
	const left = [...new Set(values)].filter(resolves);
	return left.length > 0 ? left : undefined;
}

/**
 * A change to filters, made from the filters as they are when it applies. Filters can live in the
 * URL, which changes only once a navigation is done, so a change computed from the filters on
 * screen could undo one made a moment before it.
 */
export type FiltersUpdate = (filters: IssueFilters) => IssueFilters;

/** The same filters without the properties that are not set, so equal filters look equal. */
export function compactFilters(filters: IssueFilters): IssueFilters {
	const compact: IssueFilters = {};
	for (const [key, value] of Object.entries(filters) as [keyof IssueFilters, unknown][]) {
		if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
		Object.assign(compact, { [key]: value });
	}
	return compact;
}

export function hasFilters(filters: IssueFilters): boolean {
	return Object.keys(compactFilters(filters)).length > 0;
}

/** Whether two sets of filters pick the same issues, whatever the order of their values. */
export function sameFilters(a: IssueFilters, b: IssueFilters): boolean {
	const key = (filters: IssueFilters) =>
		JSON.stringify(
			Object.entries(compactFilters(filters))
				.map(([name, value]) => [
					name,
					Array.isArray(value) ? [...value].map(String).sort() : value,
				])
				.sort(([x], [y]) => String(x).localeCompare(String(y))),
		);
	return key(a) === key(b);
}

/**
 * Whether an issue passes filters, best made active first (see `activeFilters`). `cycles` says
 * which cycles are current and next, for the filters that name them so.
 */
export function matchesFilters(
	issue: Issue,
	filters: IssueFilters,
	now = new Date(),
	cycles: RelativeCycles = NO_RELATIVE_CYCLES,
): boolean {
	const { teamIds, statuses, priorities, assigneeIds, projectIds, labelIds, due } = filters;
	const inCycle = (value: string | null) => {
		if (value === "current" || value === "next") {
			return issue.cycleId !== null && cycles[value].has(issue.cycleId);
		}
		return value === issue.cycleId;
	};
	return (
		(!teamIds || teamIds.includes(issue.teamId)) &&
		(!statuses || statuses.includes(issue.status)) &&
		(!priorities || priorities.includes(issue.priority)) &&
		(!assigneeIds || assigneeIds.includes(issue.assigneeId)) &&
		(!projectIds || projectIds.includes(issue.projectId)) &&
		(!filters.cycles || filters.cycles.some(inCycle)) &&
		(!labelIds || issue.labelIds.some((id) => labelIds.includes(id))) &&
		(!due || matchesDue(issue, due, now))
	);
}

/** One value more or one fewer; a property left without values is not set. */
export function toggleValue<T>(values: readonly T[] | undefined, value: T): T[] | undefined {
	const next = values?.includes(value)
		? values.filter((other) => other !== value)
		: [...(values ?? []), value];
	return next.length > 0 ? next : undefined;
}

/**
 * Picks a value of a filter, or unpicks it. Lists take several values; the due-date filter takes
 * one, so picking another replaces it.
 */
export function toggleFilter(
	filters: IssueFilters,
	key: IssueFilterKey,
	value: unknown,
): IssueFilters {
	if (key === "due") {
		const due = DUE_FILTERS.find((option) => option === value);
		return compactFilters({ ...filters, due: filters.due === due ? undefined : due });
	}
	const values: readonly unknown[] | undefined = filters[key];
	return compactFilters({ ...filters, [key]: toggleValue(values, value) });
}

export function isPicked(filters: IssueFilters, key: IssueFilterKey, value: unknown): boolean {
	if (key === "due") return filters.due === value;
	const values: readonly unknown[] | undefined = filters[key];
	return values?.includes(value) ?? false;
}

/**
 * What a new issue takes from filters so that it passes them: every property with one value, and
 * the labels. Properties the filters leave open are undefined.
 */
export function defaultsFromFilters(filters: IssueFilters): {
	teamId?: string;
	status?: Issue["status"];
	priority?: Issue["priority"];
	assigneeId?: string | null;
	projectId?: string | null;
	cycleId?: string | null;
	labelIds?: string[];
} {
	const only = <T>(values: readonly T[] | undefined) =>
		values?.length === 1 ? values[0] : undefined;
	return {
		teamId: only(filters.teamIds),
		status: only(filters.statuses),
		priority: only(filters.priorities),
		assigneeId: only(filters.assigneeIds),
		projectId: only(filters.projectIds),
		// A current or next cycle depends on the team, which the page knows better.
		cycleId: [only(filters.cycles)].find((value) => value !== undefined && !isRelativeCycle(value)),
		// Any one label passes a label filter; all of them do no harm and say what was meant.
		labelIds: filters.labelIds ? [...filters.labelIds] : undefined,
	};
}
