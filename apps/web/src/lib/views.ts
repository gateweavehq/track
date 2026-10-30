import {
	ISSUE_LAYOUTS,
	type IssueFilters,
	type IssueLayout,
	issueFilters,
} from "@gateweave/track-protocol";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { compactFilters, type FiltersUpdate } from "./filters";

// The protocol names them, because a saved view keeps one.
export const ISSUE_VIEWS = ISSUE_LAYOUTS;
export type IssueView = IssueLayout;

/**
 * Search params for a page of issues: its view and its filters (see `IssueFilters`), under short
 * names. Malformed values are dropped rather than failing the page, since links get mangled.
 */
export const issuePageSearch = z.object({
	view: z.enum(ISSUE_VIEWS).optional().catch(undefined),
	team: issueFilters.shape.teamIds.catch(undefined),
	status: issueFilters.shape.statuses.catch(undefined),
	priority: issueFilters.shape.priorities.catch(undefined),
	assignee: issueFilters.shape.assigneeIds.catch(undefined),
	project: issueFilters.shape.projectIds.catch(undefined),
	labels: issueFilters.shape.labelIds.catch(undefined),
	due: issueFilters.shape.due.catch(undefined),
});
export type IssuePageSearch = z.infer<typeof issuePageSearch>;

export function filtersFromSearch(search: IssuePageSearch): IssueFilters {
	return compactFilters({
		teamIds: search.team,
		statuses: search.status,
		priorities: search.priority,
		assigneeIds: search.assignee,
		projectIds: search.project,
		labelIds: search.labels,
		due: search.due,
	});
}

/** The search params for filters, every one named so that merging them clears the rest. */
export function searchFromFilters(filters: IssueFilters): Omit<IssuePageSearch, "view"> {
	return {
		team: filters.teamIds,
		status: filters.statuses,
		priority: filters.priorities,
		assignee: filters.assigneeIds,
		project: filters.projectIds,
		labels: filters.labelIds,
		due: filters.due,
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
