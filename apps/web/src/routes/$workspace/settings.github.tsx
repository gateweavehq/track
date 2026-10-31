import { createFileRoute } from "@tanstack/react-router";
import { GitHubSettings } from "#/components/settings/github-settings";
import { Notice } from "#/components/workspace/notice";
import { getWorkspaceGitHub } from "#/lib/github";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/github")({
	// Connections live in the workspace's Durable Object, behind the gateway's admin check.
	loader: ({ params }) => getWorkspaceGitHub({ data: params.workspace }),
	component: GitHubPage,
});

function GitHubPage() {
	const data = Route.useLoaderData();
	useDocumentTitle("GitHub");

	if (!data) {
		return (
			<Notice title="GitHub unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	return <GitHubSettings data={data} />;
}
