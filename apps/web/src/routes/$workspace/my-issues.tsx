import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { FILTER_KEYS } from "#/components/issues/filter-menu";
import { IssuesPage } from "#/components/issues/issues-page";
import { SaveViewButton } from "#/components/views/view-controls";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { hasFilters } from "#/lib/filters";
import { useAssignedIssues } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";
import {
	type IssuePageSearch,
	type IssueView,
	issuePageSearch,
	useIssueView,
	usePageFilters,
} from "#/lib/views";

// Everything here is assigned to the person looking.
const MY_FILTERS = FILTER_KEYS.filter((key) => key !== "assigneeIds");

export const Route = createFileRoute("/$workspace/my-issues")({
	validateSearch: issuePageSearch,
	component: MyIssuesPage,
});

function MyIssuesPage() {
	const { id: workspaceId, userId } = useWorkspace();
	const issues = useAssignedIssues(userId);
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const setSearch = useCallback(
		(patch: IssuePageSearch | ((current: IssuePageSearch) => IssuePageSearch)) =>
			void navigate({
				// A function patch is applied to the search as it is then, not as this render saw it.
				search: (prev) => ({ ...prev, ...(typeof patch === "function" ? patch(prev) : patch) }),
				replace: true,
			}),
		[navigate],
	);
	const setUrlView = useCallback((view: IssueView) => setSearch({ view }), [setSearch]);
	const scope = `mine.${workspaceId}`;
	const [view, setView] = useIssueView(scope, search.view, setUrlView);
	const { filters, onFiltersChange } = usePageFilters(search, setSearch);
	useDocumentTitle("My issues");

	return (
		<IssuesPage
			scope={scope}
			title="My issues"
			issues={issues}
			defaults={{ assigneeId: userId }}
			view={view}
			onViewChange={setView}
			filters={filters}
			onFiltersChange={onFiltersChange}
			offeredFilters={MY_FILTERS}
			filterActions={
				// A view shows issues from the whole workspace, so it keeps the assignee as a filter.
				hasFilters(filters) && (
					<SaveViewButton filters={{ ...filters, assigneeIds: [userId] }} layout={view} />
				)
			}
			empty={
				<Notice title="Nothing assigned to you">
					Issues assigned to you, in every team, show up here.
				</Notice>
			}
		/>
	);
}
