import type { Project } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Breakdown, InsightsPage } from "#/components/insights/insights-page";
import { useWorkspace } from "#/components/workspace/context";
import { localZone } from "#/lib/cycles";
import { type InsightRange, projectInsights } from "#/lib/insights";
import { useActivitiesById, useIssuesById, useStatuses, useTeamsById } from "#/lib/queries";

/**
 * A project's insights, across the teams its issues are in. A project has no time zone of its
 * own, so its weeks are the viewer's.
 */
export function ProjectInsights({
	project,
	weeks,
	onWeeksChange,
}: {
	project: Project;
	weeks: InsightRange;
	onWeeksChange: (weeks: InsightRange) => void;
}) {
	const { slug } = useWorkspace();
	const issues = useIssuesById();
	const activities = useActivitiesById();
	const statuses = useStatuses();
	const teams = useTeamsById();
	const insights = useMemo(
		() =>
			projectInsights({
				projectId: project.id,
				issues: issues.values(),
				activities: activities.values(),
				statuses,
				timeZone: localZone(),
				now: Date.now(),
				weeks,
			}),
		[project.id, issues, activities, statuses, weeks],
	);

	return (
		<InsightsPage
			trail={
				<Link
					to="/$workspace/project/$projectId"
					params={{ workspace: slug, projectId: project.id }}
					className="truncate text-sm text-muted-foreground hover:text-foreground"
				>
					{project.name}
				</Link>
			}
			insights={insights}
			weeks={weeks}
			onWeeksChange={onWeeksChange}
			breakdown={
				<Breakdown
					title="Open by team"
					rows={insights.byTeam}
					rowKey={(id) => id}
					label={(id) => {
						const team = teams.get(id);
						return (
							<>
								<span className="w-9 shrink-0 font-mono text-xs text-muted-foreground">
									{team?.key ?? ""}
								</span>
								<span className="truncate">{team?.name ?? "Deleted team"}</span>
							</>
						);
					}}
				/>
			}
		/>
	);
}
