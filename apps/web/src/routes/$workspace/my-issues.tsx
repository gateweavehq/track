import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { IssuesPage } from "#/components/issues/issues-page";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useAssignedIssues } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";
import { type IssueView, issueViewSearch, useIssueView } from "#/lib/views";

export const Route = createFileRoute("/$workspace/my-issues")({
	validateSearch: issueViewSearch,
	component: MyIssuesPage,
});

function MyIssuesPage() {
	const { id: workspaceId, userId } = useWorkspace();
	const issues = useAssignedIssues(userId);
	const navigate = useNavigate({ from: Route.fullPath });
	const setUrlView = useCallback(
		(view: IssueView) => void navigate({ search: { view }, replace: true }),
		[navigate],
	);
	const [view, setView] = useIssueView(`mine.${workspaceId}`, Route.useSearch().view, setUrlView);
	useDocumentTitle("My issues");

	return (
		<IssuesPage
			title="My issues"
			issues={issues}
			defaults={{ assigneeId: userId }}
			view={view}
			onViewChange={setView}
			empty={
				<Notice title="Nothing assigned to you">
					Issues assigned to you, in every team, show up here.
				</Notice>
			}
		/>
	);
}
