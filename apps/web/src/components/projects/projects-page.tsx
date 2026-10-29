import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import { useWorkspace, useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatTargetDate, isOverdue, progressPercent } from "#/lib/projects";
import { type ProjectSummary, useMembersById, useProjects } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { PROJECT_STATUS_META, ProjectStatusIcon } from "./meta";

/** Every project of the workspace, with who leads it, when it is due and how far along it is. */
export function ProjectsPage() {
	const actions = useWorkspaceActions();
	const projects = useProjects();

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<h1 className="truncate text-sm font-medium">Projects</h1>
				<span className="text-sm text-muted-foreground tabular-nums">{projects.length}</span>
				<Button size="sm" className="ml-auto" onClick={actions.createProject}>
					<Plus />
					<span className="hidden sm:inline">New project</span>
				</Button>
			</header>
			{projects.length === 0 ? (
				<Notice
					title="No projects yet"
					action={<Button onClick={actions.createProject}>New project</Button>}
				>
					A project groups issues from any team toward one goal, such as a launch.
				</Notice>
			) : (
				<ul aria-label="Projects">
					{projects.map((summary) => (
						<ProjectRow key={summary.project.id} summary={summary} />
					))}
				</ul>
			)}
		</div>
	);
}

function ProjectRow({ summary: { project, issues, progress } }: { summary: ProjectSummary }) {
	const { slug } = useWorkspace();
	const lead = useMembersById().get(project.leadId ?? "");
	const percent = progressPercent(progress);
	const overdue = isOverdue(project);

	return (
		<li className="relative flex min-h-12 items-center gap-3 border-b px-3 py-2 text-sm hover:bg-accent/40 sm:px-4">
			<ProjectStatusIcon status={project.status} />
			<Link
				to="/$workspace/project/$projectId"
				params={{ workspace: slug, projectId: project.id }}
				className="min-w-0 flex-1 truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
			>
				{project.name}
				<span className="sr-only">, {PROJECT_STATUS_META[project.status].label}</span>
			</Link>
			<span
				className="hidden w-36 shrink-0 items-center gap-2 truncate text-muted-foreground md:flex"
				title={lead ? `Lead: ${lead.name}` : "No lead"}
			>
				{lead && (
					<>
						<MemberAvatar member={lead} className="size-4" />
						<span className="truncate">{lead.name}</span>
					</>
				)}
			</span>
			<span
				className={cn(
					"hidden w-28 shrink-0 text-xs text-muted-foreground sm:block",
					overdue && "text-destructive",
				)}
				title={overdue ? "Past its target date" : undefined}
			>
				{project.targetDate ? formatTargetDate(project.targetDate) : ""}
			</span>
			<div
				className="flex w-28 shrink-0 items-center gap-2 text-xs text-muted-foreground sm:w-36"
				title={`${progress.done} of ${progress.total} issues done${
					issues > progress.total ? `, ${issues - progress.total} canceled` : ""
				}`}
			>
				<div
					role="progressbar"
					aria-label={`${project.name} progress`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
				>
					<div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
				</div>
				<span className="w-10 text-right tabular-nums" data-testid="project-progress">
					{progress.done}/{progress.total}
				</span>
			</div>
		</li>
	);
}
