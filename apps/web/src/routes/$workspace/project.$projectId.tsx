import type { Project } from "@gateweave/track-protocol";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { IssuesPage } from "#/components/issues/issues-page";
import { DeleteProjectButton, ProjectDetails } from "#/components/projects/project-detail";
import { Button } from "#/components/ui/button";
import { useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useProject, useProjectIssues } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";
import { type IssuePageSearch, type IssueView, issuePageSearch, useIssueView } from "#/lib/views";

export const Route = createFileRoute("/$workspace/project/$projectId")({
	validateSearch: issuePageSearch,
	component: ProjectPage,
});

function ProjectPage() {
	const { workspace, projectId } = Route.useParams();
	const project = useProject(projectId);
	useDocumentTitle(project?.name);

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
	// Keyed by project, so switching projects starts fresh: its own view, filter and selection.
	return <ProjectIssues key={project.id} project={project} />;
}

function ProjectIssues({ project }: { project: Project }) {
	const { workspace } = Route.useParams();
	const actions = useWorkspaceActions();
	const issues = useProjectIssues(project.id);
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const setSearch = useCallback(
		(patch: IssuePageSearch) =>
			void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
		[navigate],
	);
	const setUrlView = useCallback((view: IssueView) => setSearch({ view }), [setSearch]);
	const [view, setView] = useIssueView(`project.${project.id}`, search.view, setUrlView);

	return (
		<IssuesPage
			title={project.name}
			badge={
				<Link
					to="/$workspace/projects"
					params={{ workspace }}
					className="rounded border px-1.5 text-xs text-muted-foreground hover:text-foreground"
				>
					Projects
				</Link>
			}
			intro={
				<div className="relative">
					<ProjectDetails project={project} />
					<div className="absolute top-3 right-3">
						<DeleteProjectButton project={project} issueCount={issues.length} />
					</div>
				</div>
			}
			issues={issues}
			defaults={{ projectId: project.id }}
			view={view}
			onViewChange={setView}
			labelFilter={search.labels}
			onLabelFilterChange={(labels) =>
				setSearch({ labels: labels.length > 0 ? labels : undefined })
			}
			dueFilter={search.due}
			onDueFilterChange={(due) => setSearch({ due })}
			empty={
				<Notice
					title="No issues in this project"
					action={
						<Button onClick={() => actions.createIssue({ projectId: project.id })}>
							Create issue
						</Button>
					}
				>
					Press C to create one here, or set the project on an existing issue.
				</Notice>
			}
		/>
	);
}
