import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ProjectInsights } from "#/components/projects/project-insights";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";
import { INSIGHT_RANGES, type InsightRange } from "#/lib/insights";
import { useProject } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

// The range is in the address, so a link shares the same view. Twelve weeks unless it says.
const insightsSearch = z.object({
	weeks: z.literal(INSIGHT_RANGES).optional().catch(undefined),
});

export const Route = createFileRoute("/$workspace/project/$projectId_/insights")({
	validateSearch: insightsSearch,
	component: ProjectInsightsPage,
});

function ProjectInsightsPage() {
	const { workspace, projectId } = Route.useParams();
	const { weeks = 12 } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const project = useProject(projectId);
	useDocumentTitle(project ? `${project.name} insights` : undefined);

	if (!project) {
		return (
			<Notice
				title="Project not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace/projects" params={{ workspace }}>
							Back to projects
						</Link>
					</Button>
				}
			>
				It may have been deleted, or the link is wrong.
			</Notice>
		);
	}
	return (
		<ProjectInsights
			key={project.id}
			project={project}
			weeks={weeks}
			onWeeksChange={(next: InsightRange) =>
				void navigate({ search: { weeks: next === 12 ? undefined : next }, replace: true })
			}
		/>
	);
}
