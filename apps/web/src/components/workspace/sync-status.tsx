import { deleteIdbReplica, type SyncStatus } from "@gateweave/track-sync-client";
import { useSyncClient, useSyncStatus } from "@gateweave/track-sync-client/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";
import { Notice } from "./notice";

const LABELS: Record<SyncStatus["connection"], [label: string, color: string]> = {
	live: ["Live", "bg-emerald-500"],
	connecting: ["Connecting", "bg-amber-500"],
	offline: ["Offline", "bg-amber-500"],
	outdated: ["Update available", "bg-red-500"],
	unreadable: ["Local copy unreadable", "bg-red-500"],
	unauthorized: ["Signed out", "bg-red-500"],
	forbidden: ["No access", "bg-red-500"],
};

export function SyncBadge({ className }: { className?: string }) {
	const { connection, pending } = useSyncStatus();
	const [label, color] = LABELS[connection];
	return (
		<p
			className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}
			title={pending > 0 ? `${pending} changes not yet saved to the server` : undefined}
		>
			<span className={cn("size-2 rounded-full", color)} />
			{label}
			{pending > 0 && <span>· {pending} unsynced</span>}
		</p>
	);
}

/**
 * Renders the page once the local replica has loaded. When the connection fails for good, it
 * explains why instead, since the data on screen can no longer be trusted or saved.
 */
export function SyncGate({ children, storageKey }: { children: ReactNode; storageKey: string }) {
	const { connection, loaded } = useSyncStatus();
	const client = useSyncClient();
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	if (connection === "unreadable") {
		return (
			<>
				<Notice
					title="This device's local copy cannot be read"
					action={<Button onClick={() => setConfirmDiscard(true)}>Discard local copy</Button>}
				>
					Some changes stored on this device may not have reached the server. You can still read any
					data shown below. Discard the local copy to download a fresh one.
				</Notice>
				{loaded && children}
				{confirmDiscard && (
					<ConfirmDialog
						title="Discard this device's local copy?"
						confirmLabel="Discard local copy"
						onClose={() => setConfirmDiscard(false)}
						onConfirm={async () => {
							await client.close();
							await deleteIdbReplica(storageKey);
							window.location.reload();
						}}
					>
						Changes that have not reached the server will be lost. This device will download a fresh
						copy of the workspace.
					</ConfirmDialog>
				)}
			</>
		);
	}

	if (connection === "outdated") {
		return (
			<Notice
				title="A new version of Gateweave Track is available"
				action={<Button onClick={() => window.location.reload()}>Reload</Button>}
			>
				Reload the page to keep working.
			</Notice>
		);
	}
	if (connection === "unauthorized") {
		return (
			<Notice
				title="Your session has ended"
				action={
					<Button asChild>
						<Link to="/login">Sign in again</Link>
					</Button>
				}
			/>
		);
	}
	if (connection === "forbidden") {
		return (
			<Notice
				title="You no longer have access to this workspace"
				action={
					<Button asChild variant="outline">
						<Link to="/">Your workspaces</Link>
					</Button>
				}
			/>
		);
	}
	if (!loaded) {
		return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
	}
	return children;
}
