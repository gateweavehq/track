import { createFileRoute } from "@tanstack/react-router";
import { AuditSettings } from "#/components/settings/audit-settings";
import { Notice } from "#/components/workspace/notice";
import { getAuditLog } from "#/lib/audit";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/audit")({
	// The log lives in the workspace's Durable Object, which reads it to admins only.
	loader: ({ params }) => getAuditLog({ data: { workspace: params.workspace } }),
	component: AuditPage,
});

function AuditPage() {
	const data = Route.useLoaderData();
	useDocumentTitle("Audit log");

	if (!data) {
		return (
			<Notice title="Audit log unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	// A new first page, as after a change, starts the list again.
	return <AuditSettings key={data.page.events[0]?.id ?? 0} data={data} />;
}
