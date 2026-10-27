import type { Team } from "@tangent/protocol";
import { createFileRoute, Link } from "@tanstack/react-router";
import { IssuesPage } from "#/components/issues/issues-page";
import { Button } from "#/components/ui/button";
import { useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useTeamByKey, useTeamIssues } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/team/$teamKey")({
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
	return <TeamIssues team={team} />;
}

function TeamIssues({ team }: { team: Team }) {
	const actions = useWorkspaceActions();
	const issues = useTeamIssues(team.id);

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
