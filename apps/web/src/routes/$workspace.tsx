import { createBrowserSyncClient, type SyncClient } from "@tangent/sync-client";
import { SyncProvider } from "@tangent/sync-client/react";
import { createFileRoute, notFound, Outlet, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { WorkspaceActionsProvider } from "#/components/workspace/actions";
import { AppShell } from "#/components/workspace/app-shell";
import { WorkspaceProvider } from "#/components/workspace/context";
import { SyncGate } from "#/components/workspace/sync-status";
import { getSession } from "#/lib/session";
import { getWorkspace } from "#/lib/workspace";

// The workspace app runs entirely on the sync client: data comes from IndexedDB first, edits
// apply instantly, and changes stream in live. There is nothing useful to render on the server.
export const Route = createFileRoute("/$workspace")({
	ssr: false,
	beforeLoad: async () => {
		if (!(await getSession())) throw redirect({ to: "/login" });
	},
	loader: async ({ params }) => {
		const workspace = await getWorkspace({ data: params.workspace });
		if (!workspace) throw notFound();
		return workspace;
	},
	component: WorkspaceLayout,
});

function WorkspaceLayout() {
	const { workspace: slug } = Route.useParams();
	const workspace = Route.useLoaderData();
	const client = useWorkspaceClient(slug, workspace.id, workspace.userId);
	if (!client) return null;

	return (
		<WorkspaceProvider workspace={{ ...workspace, slug }}>
			<SyncProvider client={client}>
				<WorkspaceActionsProvider>
					<AppShell>
						<SyncGate>
							<Outlet />
						</SyncGate>
					</AppShell>
				</WorkspaceActionsProvider>
			</SyncProvider>
		</WorkspaceProvider>
	);
}

function useWorkspaceClient(slug: string, workspaceId: string, userId: string) {
	const [client, setClient] = useState<SyncClient | null>(null);
	useEffect(() => {
		const next = createBrowserSyncClient({
			workspace: slug,
			// Keyed by ids, so a renamed workspace keeps its local data.
			storageKey: `${userId}:${workspaceId}`,
			userId,
			onReject: (error) => toast.error("Your change was not saved", { description: error.message }),
		});
		setClient(next);
		return () => {
			void next.close();
		};
	}, [slug, workspaceId, userId]);
	return client;
}
