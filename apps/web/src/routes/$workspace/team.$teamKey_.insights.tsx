import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { TeamInsights } from "#/components/teams/team-insights";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";
import { type InsightSearch, insightSearch } from "#/lib/insights";
import { useTeamByKey } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/team/$teamKey_/insights")({
	validateSearch: insightSearch,
	component: TeamInsightsPage,
});

function TeamInsightsPage() {
	const { workspace, teamKey } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const team = useTeamByKey(teamKey);
	useDocumentTitle(team ? `${team.name} insights` : undefined);

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
	return (
		<TeamInsights
			key={team.id}
			team={team}
			search={search}
			onSearchChange={(patch: Partial<InsightSearch>) =>
				void navigate({
					// Twelve weeks is the default, so the address leaves it out.
					search: (prev) => {
						const next = { ...prev, ...patch };
						return { ...next, weeks: next.weeks === 12 ? undefined : next.weeks };
					},
					replace: true,
				})
			}
		/>
	);
}
