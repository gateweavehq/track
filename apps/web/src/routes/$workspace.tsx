import { createBrowserSyncClient, type SyncClient } from "@gateweave/track-sync-client";
import { SyncProvider } from "@gateweave/track-sync-client/react";
import { createFileRoute, Link, notFound, Outlet, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { WorkspaceActionsProvider } from "#/components/workspace/actions";
import { AppShell } from "#/components/workspace/app-shell";
import { WorkspaceProvider } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { SyncGate } from "#/components/workspace/sync-status";
import { forgetWorkspace, replicaKey } from "#/lib/replica";
import { getSession } from "#/lib/session";
import { getWorkspace } from "#/lib/workspace";

// The workspace app runs entirely on the sync client: data comes from IndexedDB first, edits
// apply instantly, and changes stream in live. There is nothing useful to render on the server.
export const Route = createFileRoute("/$workspace")({
	ssr: false,
	beforeLoad: async ({ location }) => {
		if (!(await getSession())) {
			throw redirect({ to: "/login", search: { redirect: location.href } });
		}
	},
	loader: async ({ params }) => {
		const workspace = await getWorkspace({ data: params.workspace });
		if (!workspace) throw notFound();
		return workspace;
	},
	component: WorkspaceLayout,
	notFoundComponent: WorkspaceNotFound,
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

// A missing workspace and one the user may not see look the same, on purpose: the response must
// not reveal which slugs exist.
function WorkspaceNotFound() {
	return (
		<main className="grid min-h-svh place-items-center">
			<Notice
				title="Workspace not found"
				action={
					<Button asChild variant="outline">
						<Link to="/">Your workspaces</Link>
					</Button>
				}
			>
				It doesn't exist, or your account doesn't have access to it. If someone invited you, open
				the link they sent.
			</Notice>
		</main>
	);
}

function useWorkspaceClient(slug: string, workspaceId: string, userId: string) {
	const [client, setClient] = useState<SyncClient | null>(null);
	useEffect(() => {
		const next = createBrowserSyncClient({
			workspace: slug,
			storageKey: replicaKey(userId, workspaceId),
			userId,
			onReject: (error) => toast.error("Your change was not saved", { description: error.message }),
		});
		// Access is gone: the user was removed, or the workspace deleted.
		const unsubscribe = next.subscribeStatus(() => {
			if (next.getStatus().connection !== "forbidden") return;
			void next.close().then(() => forgetWorkspace(userId, workspaceId));
		});
		setClient(next);
		return () => {
			unsubscribe();
			void next.close();
		};
	}, [slug, workspaceId, userId]);
	return client;
}
