import { createFileRoute } from "@tanstack/react-router";
import { WebhooksSettings } from "#/components/settings/webhooks-settings";
import { Notice } from "#/components/workspace/notice";
import { useDocumentTitle } from "#/lib/title";
import { getWorkspaceWebhooks } from "#/lib/webhooks";

export const Route = createFileRoute("/$workspace/settings/webhooks")({
	// Webhooks live in the workspace's Durable Object, behind the gateway's admin check.
	loader: ({ params }) => getWorkspaceWebhooks({ data: params.workspace }),
	component: WebhooksPage,
});

function WebhooksPage() {
	const data = Route.useLoaderData();
	useDocumentTitle("Webhooks");

	if (!data) {
		return (
			<Notice title="Webhooks unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	return <WebhooksSettings data={data} />;
}
