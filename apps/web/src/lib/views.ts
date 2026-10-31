import {
	compactDisplay,
	GROUP_BYS,
	ISSUE_LAYOUTS,
	type IssueDisplay,
	type IssueFilters,
	type IssueLayout,
	issueDisplay,
	issueFilters,
	ORDER_BYS,
} from "@gateweave/track-protocol";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { type DisplayUpdate, sortFromParam, sortToParam } from "./display";
import { compactFilters, type FiltersUpdate } from "./filters";

// The protocol names them, because a saved view keeps one.
export const ISSUE_VIEWS = ISSUE_LAYOUTS;
export type IssueView = IssueLayout;

/**
 * Search params for a page of issues: its view, its filters (see `IssueFilters`) and its display
 * options (see `IssueDisplay`), under short names. Malformed values are dropped rather than
 * failing the page, since links get mangled.
 */
export const issuePageSearch = z.object({
	view: z.enum(ISSUE_VIEWS).optional().catch(undefined),
	team: issueFilters.shape.teamIds.catch(undefined),
	status: issueFilters.shape.statuses.catch(undefined),
	priority: issueFilters.shape.priorities.catch(undefined),
	assignee: issueFilters.shape.assigneeIds.catch(undefined),
	project: issueFilters.shape.projectIds.catch(undefined),
	cycle: issueFilters.shape.cycles.catch(undefined),
	labels: issueFilters.shape.labelIds.catch(undefined),
	due: issueFilters.shape.due.catch(undefined),
	group: z.enum(GROUP_BYS).optional().catch(undefined),
	order: z.enum(ORDER_BYS).optional().catch(undefined),
	props: issueDisplay.shape.properties.catch(undefined),
	columns: issueDisplay.shape.columns.catch(undefined),
	// A column and a direction, such as `dueDate.desc`.
	sort: z.string().max(40).optional().catch(undefined),
});
export type IssuePageSearch = z.infer<typeof issuePageSearch>;

export function filtersFromSearch(search: IssuePageSearch): IssueFilters {
	return compactFilters({
		teamIds: search.team,
		statuses: search.status,
		priorities: search.priority,
		assigneeIds: search.assignee,
		projectIds: search.project,
		cycles: search.cycle,
		labelIds: search.labels,
		due: search.due,
	});
}

const DISPLAY_KEYS = ["group", "order", "props", "columns", "sort"] as const;

/** The search params for filters, every one named so that merging them clears the rest. */
export function searchFromFilters(
	filters: IssueFilters,
): Omit<IssuePageSearch, "view" | (typeof DISPLAY_KEYS)[number]> {
	return {
		team: filters.teamIds,
		status: filters.statuses,
		priority: filters.priorities,
		assignee: filters.assigneeIds,
		project: filters.projectIds,
		cycle: filters.cycles,
		labels: filters.labelIds,
		due: filters.due,
	};
}

export function displayFromSearch(search: IssuePageSearch): IssueDisplay {
	return compactDisplay({
		groupBy: search.group,
		orderBy: search.order,
		properties: search.props,
		columns: search.columns,
		sort: sortFromParam(search.sort),
	});
}

/** The search params for display options, every one named so that merging them clears the rest. */
export function searchFromDisplay(
	display: IssueDisplay,
): Pick<IssuePageSearch, (typeof DISPLAY_KEYS)[number]> {
	const compact = compactDisplay(display);
	return {
		group: compact.groupBy,
		order: compact.orderBy,
		props: compact.properties,
		columns: compact.columns,
		sort: sortToParam(compact.sort),
	};
}

/** A page's filters, read from its search params and written back to them. */
export function usePageFilters(
	search: IssuePageSearch,
	setSearch: (patch: IssuePageSearch | ((current: IssuePageSearch) => IssuePageSearch)) => void,
): { filters: IssueFilters; onFiltersChange: (update: FiltersUpdate) => void } {
	const filters = useMemo(() => filtersFromSearch(search), [search]);
	const onFiltersChange = useCallback(
		(update: FiltersUpdate) =>
			setSearch((current) => searchFromFilters(update(filtersFromSearch(current)))),
		[setSearch],
	);
	return { filters, onFiltersChange };
}

const storageKey = (scope: string) => `track.view.${scope}`;

function readView(scope: string): IssueView | null {
	try {
		const value = localStorage.getItem(storageKey(scope));
		return ISSUE_VIEWS.find((view) => view === value) ?? null;
	} catch {
		// Storage can be unavailable, for example in a locked-down private window.
		return null;
	}
}

function writeView(scope: string, view: IssueView) {
	try {
		localStorage.setItem(storageKey(scope), view);
	} catch {
		// Remembering the view is a convenience; the URL still carries it.
	}
}

/**
 * The view of a page of issues: the one in the URL, else the one last used on this page (its
 * `scope`), else the list. Choosing a view remembers it and puts it in the URL, so links to a
 * board open as a board. Remount the caller when `scope` changes.
 */
export function useIssueView(
	scope: string,
	fromUrl: IssueView | undefined,
	setUrl: (view: IssueView) => void,
): [IssueView, (view: IssueView) => void] {
	const [remembered, setRemembered] = useState(() => readView(scope));
	const change = useCallback(
		(view: IssueView) => {
			writeView(scope, view);
			setRemembered(view);
			setUrl(view);
		},
		[scope, setUrl],
	);
	return [fromUrl ?? remembered ?? "list", change];
}

/** A page's display options, read from its search params and written back to them. */
export function usePageDisplay(
	search: IssuePageSearch,
	setSearch: (patch: IssuePageSearch | ((current: IssuePageSearch) => IssuePageSearch)) => void,
): { display: IssueDisplay; onDisplayChange: (update: DisplayUpdate) => void } {
	const display = useMemo(() => displayFromSearch(search), [search]);
	const onDisplayChange = useCallback(
		(update: DisplayUpdate) =>
			setSearch((current) => searchFromDisplay(update(displayFromSearch(current)))),
		[setSearch],
	);
	return { display, onDisplayChange };
}
