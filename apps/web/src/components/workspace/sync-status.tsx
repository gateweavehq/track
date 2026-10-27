import type { SyncStatus } from "@tangent/sync-client";
import { useSyncStatus } from "@tangent/sync-client/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { Notice } from "./notice";

const LABELS: Record<SyncStatus["connection"], [label: string, color: string]> = {
	live: ["Live", "bg-emerald-500"],
	connecting: ["Connecting", "bg-amber-500"],
	offline: ["Offline", "bg-amber-500"],
	outdated: ["Update available", "bg-red-500"],
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
export function SyncGate({ children }: { children: ReactNode }) {
	const { connection, loaded } = useSyncStatus();

	if (connection === "outdated") {
		return (
			<Notice
				title="A new version of Tangent is available"
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
