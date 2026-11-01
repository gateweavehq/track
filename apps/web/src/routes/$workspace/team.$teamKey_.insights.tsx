import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { TeamInsights } from "#/components/teams/team-insights";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";
import { INSIGHT_RANGES, type InsightRange } from "#/lib/insights";
import { useTeamByKey } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

// The range is in the address, so a link shares the same view. Twelve weeks unless it says.
const insightsSearch = z.object({
	weeks: z.literal(INSIGHT_RANGES).optional().catch(undefined),
});

export const Route = createFileRoute("/$workspace/team/$teamKey_/insights")({
	validateSearch: insightsSearch,
	component: TeamInsightsPage,
});

function TeamInsightsPage() {
	const { workspace, teamKey } = Route.useParams();
	const { weeks = 12 } = Route.useSearch();
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
			weeks={weeks}
			onWeeksChange={(next: InsightRange) =>
				void navigate({ search: { weeks: next === 12 ? undefined : next }, replace: true })
			}
		/>
	);
}
