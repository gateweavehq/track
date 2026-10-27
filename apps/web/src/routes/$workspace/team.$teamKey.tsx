import type { Team } from "@gateweave/track-protocol";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { IssuesPage } from "#/components/issues/issues-page";
import { Button } from "#/components/ui/button";
import { useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useTeamByKey, useTeamIssues } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";
import { type IssueView, issueViewSearch, useIssueView } from "#/lib/views";

export const Route = createFileRoute("/$workspace/team/$teamKey")({
	validateSearch: issueViewSearch,
	component: TeamPage,
});

function TeamPage() {
	const { workspace, teamKey } = Route.useParams();
	const team = useTeamByKey(teamKey);
	useDocumentTitle(team?.name);

	if (!team) {
		return (
			<Notice
				title="Team not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace" params={{ workspace }}>
							Back to the workspace
						</Link>
					</Button>
				}
			>
				No team in this workspace uses the key {teamKey.toUpperCase()}.
			</Notice>
		);
	}
	// Keyed by team, so switching teams starts fresh: its own view, filter and selection.
	return <TeamIssues key={team.id} team={team} />;
}

function TeamIssues({ team }: { team: Team }) {
	const actions = useWorkspaceActions();
	const issues = useTeamIssues(team.id);
	const navigate = useNavigate({ from: Route.fullPath });
	const setUrlView = useCallback(
		(view: IssueView) => void navigate({ search: { view }, replace: true }),
		[navigate],
	);
	const [view, setView] = useIssueView(`team.${team.id}`, Route.useSearch().view, setUrlView);

	return (
		<IssuesPage
			title={team.name}
			badge={
				<span className="rounded border px-1.5 font-mono text-xs text-muted-foreground">
					{team.key}
				</span>
			}
			issues={issues}
			defaults={{ teamId: team.id }}
			view={view}
			onViewChange={setView}
			empty={
				<Notice
					title="No issues yet"
					action={
						<Button onClick={() => actions.createIssue({ teamId: team.id })}>Create issue</Button>
					}
				>
					Press C anywhere to create one.
				</Notice>
			}
		/>
	);
}
