import { createFileRoute } from "@tanstack/react-router";
import { IssuesPage } from "#/components/issues/issues-page";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useAssignedIssues } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/my-issues")({
	component: MyIssuesPage,
});

function MyIssuesPage() {
	const { userId } = useWorkspace();
	const issues = useAssignedIssues(userId);
	useDocumentTitle("My issues");

	return (
		<IssuesPage
			title="My issues"
			issues={issues}
			defaults={{ assigneeId: userId }}
			empty={
				<Notice title="Nothing assigned to you">
					Issues assigned to you, in every team, show up here.
				</Notice>
			}
		/>
	);
}
