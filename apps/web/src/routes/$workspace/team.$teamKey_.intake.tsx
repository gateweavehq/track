import { createFileRoute, Link } from "@tanstack/react-router";
import { TeamIntake } from "#/components/issues/intake";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";
import { useTeamByKey } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/team/$teamKey_/intake")({
	component: TeamIntakePage,
});

function TeamIntakePage() {
	const { workspace, teamKey } = Route.useParams();
	const team = useTeamByKey(teamKey);
	useDocumentTitle(team ? `${team.name} intake` : undefined);

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
	return <TeamIntake key={team.id} team={team} />;
}
