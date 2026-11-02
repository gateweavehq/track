import type { Team } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Breakdown, InsightsPage } from "#/components/insights/insights-page";
import { StatusIcon } from "#/components/issues/meta";
import { useWorkspace } from "#/components/workspace/context";
import { teamZone } from "#/lib/cycles";
import { type InsightSearch, matchesInsightSearch, teamInsights } from "#/lib/insights";
import { useActiveIssuesById, useActivitiesById, useStatuses } from "#/lib/queries";

/** A team's insights, in its cycles' time zone when it has cycles. */
export function TeamInsights({
	team,
	search,
	onSearchChange,
}: {
	team: Team;
	search: InsightSearch;
	onSearchChange: (patch: Partial<InsightSearch>) => void;
}) {
	const { slug } = useWorkspace();
	// Archived issues' history and labels stay on the server, so insights read the others.
	const issues = useActiveIssuesById();
	const activities = useActivitiesById();
	const statuses = useStatuses();
	const insights = useMemo(
		() =>
			teamInsights({
				teamId: team.id,
				issues: [...issues.values()].filter((issue) => matchesInsightSearch(issue, search)),
				activities: activities.values(),
				statuses,
				timeZone: teamZone(team),
				now: Date.now(),
				weeks: search.weeks ?? 12,
			}),
		[team, issues, activities, statuses, search],
	);

	return (
		<InsightsPage
			trail={
				<Link
					to="/$workspace/team/$teamKey"
					params={{ workspace: slug, teamKey: team.key }}
					className="truncate text-sm text-muted-foreground hover:text-foreground"
				>
					{team.name}
				</Link>
			}
			insights={insights}
			search={search}
			onSearchChange={onSearchChange}
			breakdown={
				<Breakdown
					title="Open by status"
					rows={insights.byStatus}
					rowKey={(status) => status.id}
					label={(status) => (
						<>
							<StatusIcon status={status} />
							<span className="truncate">{status.name}</span>
						</>
					)}
				/>
			}
		/>
	);
}
