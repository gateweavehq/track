import type { Project } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Breakdown, InsightsPage } from "#/components/insights/insights-page";
import { useWorkspace } from "#/components/workspace/context";
import { localZone } from "#/lib/cycles";
import { type InsightSearch, matchesInsightSearch, projectInsights } from "#/lib/insights";
import { useActiveIssuesById, useActivitiesById, useStatuses, useTeamsById } from "#/lib/queries";

/**
 * A project's insights, across the teams its issues are in. A project has no time zone of its
 * own, so its weeks are the viewer's.
 */
export function ProjectInsights({
	project,
	search,
	onSearchChange,
}: {
	project: Project;
	search: InsightSearch;
	onSearchChange: (patch: Partial<InsightSearch>) => void;
}) {
	const { slug } = useWorkspace();
	// Archived issues' history and labels stay on the server, so insights read the others.
	const issues = useActiveIssuesById();
	const activities = useActivitiesById();
	const statuses = useStatuses();
	const teams = useTeamsById();
	const insights = useMemo(
		() =>
			projectInsights({
				projectId: project.id,
				issues: [...issues.values()].filter((issue) => matchesInsightSearch(issue, search)),
				activities: activities.values(),
				statuses,
				timeZone: localZone(),
				now: Date.now(),
				weeks: search.weeks ?? 12,
			}),
		[project.id, issues, activities, statuses, search],
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
			search={search}
			onSearchChange={onSearchChange}
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
