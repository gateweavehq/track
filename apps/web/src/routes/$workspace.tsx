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
import { issueKey } from "#/lib/issues";
import { changeName, rejectionReporter } from "#/lib/mutations";
import {
	forgetKnownWorkspace,
	knownWorkspace,
	rememberWorkspace,
	withOfflineFallback,
} from "#/lib/offline";
import { forgetWorkspace, replicaKey } from "#/lib/replica";
import { getSession } from "#/lib/session";
import { getWorkspace } from "#/lib/workspace";

// The workspace app runs entirely on the sync client: data comes from IndexedDB first, edits
// apply instantly, and changes stream in live. There is nothing useful to render on the server.
//
// Without a connection, a workspace this device already holds opens from its copy. Nothing is
// exposed that is not on the device already, and the server checks the session and membership
// again as soon as the sync client reconnects.
export const Route = createFileRoute("/$workspace")({
	ssr: false,
	beforeLoad: async ({ location, params }) => {
		const signedIn = await withOfflineFallback(
			async () => Boolean(await getSession()),
			() => (knownWorkspace(params.workspace) ? true : undefined),
		);
		if (!signedIn) throw redirect({ to: "/login", search: { redirect: location.href } });
	},
	loader: async ({ params }) => {
		const workspace = await withOfflineFallback(
			() => getWorkspace({ data: params.workspace }),
			() => knownWorkspace(params.workspace),
		);
		if (!workspace) {
			// The server says no: drop what this device kept under that address.
			const known = knownWorkspace(params.workspace);
			if (known) await forgetWorkspace(known.userId, known.id).catch(() => {});
			forgetKnownWorkspace({ slug: params.workspace });
			throw notFound();
		}
		rememberWorkspace(params.workspace, workspace);
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

/**
 * Whether this person, still signed in, is no longer a member. Their connection says so as well, and
 * a tab they are leaving from may be on its way out with something to say, so it should not reload.
 */
async function lostWorkspace(slug: string): Promise<boolean> {
	try {
		return Boolean(await getSession()) && !(await getWorkspace({ data: slug }));
	} catch {
		return false;
	}
}

function useWorkspaceClient(slug: string, workspaceId: string, userId: string) {
	const [client, setClient] = useState<SyncClient | null>(null);
	useEffect(() => {
		// Refusals no one waits for, such as changes queued offline before a reload, arrive together
		// when the tab reconnects: they are summed up, naming the issues they would have changed.
		const report = rejectionReporter((error) => {
			const state = next.getState();
			return changeName(error.mutation, (id) => {
				const issue = state.issues.get(id);
				return issue && issueKey(state.teams.get(issue.teamId), issue);
			});
		});
		const next = createBrowserSyncClient({
			workspace: slug,
			storageKey: replicaKey(userId, workspaceId),
			userId,
			onReject: (error) => report(error),
			// Another tab deleted this device's copy, and this one cannot go on from memory: tabs opened
			// after it would read an empty database and wait for it. Reloading lets go of what it holds,
			// and of the lock, and finds out where it belongs now.
			onDeleted: () => {
				void lostWorkspace(slug).then((lost) => {
					if (!lost) window.location.reload();
				});
			},
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
