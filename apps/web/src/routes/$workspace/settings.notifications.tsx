import { createFileRoute } from "@tanstack/react-router";
import { NotificationSettings } from "#/components/settings/notification-settings";
import { Notice } from "#/components/workspace/notice";
import { getNotificationSettings } from "#/lib/notifications";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/notifications")({
	// Settings live in the workspace's Durable Object, one row per person.
	loader: ({ params }) => getNotificationSettings({ data: params.workspace }),
	component: NotificationsPage,
});

function NotificationsPage() {
	const data = Route.useLoaderData();
	useDocumentTitle("Notifications");

	if (!data) {
		return (
			<Notice title="Notifications unavailable">
				You are no longer a member of this workspace.
			</Notice>
		);
	}
	return <NotificationSettings data={data} />;
}
