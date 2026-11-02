import { isActiveIssue } from "@gateweave/track-protocol";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArchivedIssueDetail } from "#/components/issues/archive";
import { IssueDetail } from "#/components/issues/issue-detail";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";
import { issueKey, parseIssueKey } from "#/lib/issues";
import { useIssue, useTeamByKey } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/issue/$issueKey")({
	component: IssuePage,
});

function IssuePage() {
	const { workspace, issueKey: key } = Route.useParams();
	const parsed = parseIssueKey(key);
	const team = useTeamByKey(parsed?.teamKey ?? "");
	const issue = useIssue(team?.id, parsed?.number ?? 0);
	useDocumentTitle(issue && team ? `${issueKey(team, issue)} ${issue.title}` : undefined);

	if (!team || !issue) {
		return (
			<Notice
				title="Issue not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace" params={{ workspace }}>
							Back to the workspace
						</Link>
					</Button>
				}
			>
				It may have been deleted, or the link is wrong.
			</Notice>
		);
	}
	// Keyed by id so moving between issues starts with fresh drafts and menus.
	return isActiveIssue(issue) ? (
		<IssueDetail key={issue.id} issue={issue} team={team} />
	) : (
		<ArchivedIssueDetail key={issue.id} issue={issue} team={team} />
	);
}
