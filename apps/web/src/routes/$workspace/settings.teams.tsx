import { createFileRoute } from "@tanstack/react-router";
import { TeamsSettings } from "#/components/settings/teams-settings";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/teams")({
	component: TeamsPage,
});

function TeamsPage() {
	useDocumentTitle("Teams");
	return <TeamsSettings />;
}
