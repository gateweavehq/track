import {
	DISCARD_TIMEOUT_MS,
	deleteIdbReplica,
	type SyncStatus,
} from "@gateweave/track-sync-client";
import { useSyncClient, useSyncStatus } from "@gateweave/track-sync-client/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { issueKey } from "#/lib/issues";
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
	// Any status change, the pending count included, renders again, so the list below stays current.
	const { connection, loaded } = useSyncStatus();
	const client = useSyncClient();
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [discardMessage, setDiscardMessage] = useState("");
	const discardAttempt = useRef(0);
	const readable = client.getPending();
	const descriptions = readable.slice(0, 5).map(({ mutation }) => {
		const { args } = mutation;
		const id = "id" in args && typeof args.id === "string" ? args.id : undefined;
		const state = id ? client.getState() : undefined;
		const issue = id && state ? state.issues.get(id) : undefined;
		const detail =
			"title" in args && typeof args.title === "string"
				? args.title
				: "key" in args && typeof args.key === "string"
					? args.key
					: issue && state
						? issueKey(state.teams.get(issue.teamId), issue)
						: undefined;
		return detail ? `${mutation.name} (${detail})` : mutation.name;
	});

	if (connection === "unreadable") {
		return (
			<>
				<Notice
					title="This device's local copy cannot be read"
					action={
						<Button
							onClick={() => {
								discardAttempt.current++;
								setDiscardMessage("");
								setConfirmDiscard(true);
							}}
						>
							Discard local copy
						</Button>
					}
				>
					Some changes stored on this device may not have reached the server. You can still read any
					data shown below. Discard the local copy to download a fresh one.
				</Notice>
				{loaded && children}
				{confirmDiscard && (
					<ConfirmDialog
						title="Discard this device's local copy?"
						confirmLabel="Discard local copy"
						allowCancelWhilePending
						onClose={() => {
							discardAttempt.current++;
							setConfirmDiscard(false);
						}}
						onConfirm={async () => {
							const attempt = discardAttempt.current;
							await client.close();
							if (attempt !== discardAttempt.current) return;
							try {
								await deleteIdbReplica(storageKey, {
									onBlocked: () => {
										if (attempt === discardAttempt.current)
											setDiscardMessage(
												"Another tab of this workspace is open. Close it to finish discarding this copy.",
											);
									},
								});
								if (attempt === discardAttempt.current) window.location.reload();
							} catch (error) {
								if (attempt === discardAttempt.current)
									setDiscardMessage(
										error instanceof Error && error.message === "Discard timed out"
											? `Discard stopped waiting after ${DISCARD_TIMEOUT_MS / 1000} seconds. Close other workspace tabs before trying again. The deletion may still finish after you leave this dialog.`
											: "The local copy could not be deleted. Please try again.",
									);
								throw error;
							}
						}}
					>
						{readable.length > 0 ? (
							<>
								{readable.length === 1
									? "1 change that has not reached the server will be lost:"
									: `${readable.length} changes that have not reached the server will be lost:`}{" "}
								{descriptions.join(", ")}
								{readable.length > 5 ? `, and ${readable.length - 5} more` : ""}.
							</>
						) : (
							"This version could not list unsent changes. Discarding deletes all local changes, including changes it could not list."
						)}{" "}
						This device will download a fresh copy of the workspace. Once deletion starts, closing
						this dialog cannot stop it.
						{discardMessage && <span role="alert"> {discardMessage}</span>}
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
