import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { IssuesPage } from "#/components/issues/issues-page";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useAssignedIssues } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";
import { type IssuePageSearch, type IssueView, issuePageSearch, useIssueView } from "#/lib/views";

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
		(patch: IssuePageSearch) =>
			void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
		[navigate],
	);
	const setUrlView = useCallback((view: IssueView) => setSearch({ view }), [setSearch]);
	const scope = `mine.${workspaceId}`;
	const [view, setView] = useIssueView(scope, search.view, setUrlView);
	useDocumentTitle("My issues");

	return (
		<IssuesPage
			scope={scope}
			title="My issues"
			issues={issues}
			defaults={{ assigneeId: userId }}
			view={view}
			onViewChange={setView}
			labelFilter={search.labels}
			onLabelFilterChange={(labels) =>
				setSearch({ labels: labels.length > 0 ? labels : undefined })
			}
			dueFilter={search.due}
			onDueFilterChange={(due) => setSearch({ due })}
			empty={
				<Notice title="Nothing assigned to you">
					Issues assigned to you, in every team, show up here.
				</Notice>
			}
		/>
	);
}
