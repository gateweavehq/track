import type { Team } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Breakdown, InsightsPage } from "#/components/insights/insights-page";
import { StatusIcon } from "#/components/issues/meta";
import { useWorkspace } from "#/components/workspace/context";
import { teamZone } from "#/lib/cycles";
import { type InsightRange, teamInsights } from "#/lib/insights";
import { useActivitiesById, useIssuesById, useStatuses } from "#/lib/queries";

/** A team's insights, in its cycles' time zone when it has cycles. */
export function TeamInsights({
	team,
	weeks,
	onWeeksChange,
}: {
	team: Team;
	weeks: InsightRange;
	onWeeksChange: (weeks: InsightRange) => void;
}) {
	const { slug } = useWorkspace();
	const issues = useIssuesById();
	const activities = useActivitiesById();
	const statuses = useStatuses();
	const insights = useMemo(
		() =>
			teamInsights({
				teamId: team.id,
				issues: issues.values(),
				activities: activities.values(),
				statuses,
				timeZone: teamZone(team),
				now: Date.now(),
				weeks,
			}),
		[team, issues, activities, statuses, weeks],
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
			weeks={weeks}
			onWeeksChange={onWeeksChange}
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
