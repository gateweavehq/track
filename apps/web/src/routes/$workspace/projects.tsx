import { createFileRoute } from "@tanstack/react-router";
import { ProjectsPage } from "#/components/projects/projects-page";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/projects")({
	component: Projects,
});

function Projects() {
	useDocumentTitle("Projects");
	return <ProjectsPage />;
}
