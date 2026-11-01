import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ProjectInsights } from "#/components/projects/project-insights";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";
import { type InsightSearch, insightSearch } from "#/lib/insights";
import { useProject } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/project/$projectId_/insights")({
	validateSearch: insightSearch,
	component: ProjectInsightsPage,
});

function ProjectInsightsPage() {
	const { workspace, projectId } = Route.useParams();
	const search = Route.useSearch();
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
