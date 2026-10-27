import { type MutationError, SyncClient } from "./client";
import { openIdbPersistence } from "./idb";
import { MemoryPersistence } from "./persistence";
import { browserTabs, supportsBrowserTabs } from "./tabs";
import { httpTransport } from "./transport";

export interface BrowserSyncClientOptions {
	/** Workspace slug, as used in URLs. */
	workspace: string;
	/**
	 * Identifies the local replica. Must be unique per user and workspace (for example
	 * `${userId}:${workspaceId}`) and must not change when the workspace is renamed.
	 */
	storageKey: string;
	userId: string;
	onReject?: (error: MutationError) => void;
	/** Origin of the app. Defaults to the current page's origin. */
	baseUrl?: string;
}

/**
 * Creates a client wired to the browser: the app's sync gateway, an IndexedDB replica shared by
 * all tabs, and leader election so a browser holds one connection per workspace. Falls back to
 * an in-memory replica per tab where IndexedDB or the Web Locks API is unavailable.
 */
export function createBrowserSyncClient(options: BrowserSyncClientOptions): SyncClient {
	const { workspace, storageKey, userId, onReject, baseUrl } = options;
	const shared = supportsBrowserTabs();
	return new SyncClient({
		userId,
		onReject,
		transport: httpTransport({ workspace, baseUrl }),
		persistence: shared
			? openIdbPersistence(storageKey).catch((error: unknown) => {
					console.warn("sync: IndexedDB is unavailable; keeping data in memory", error);
					return new MemoryPersistence();
				})
			: new MemoryPersistence(),
		tabs: shared ? browserTabs(`tangent:${storageKey}`) : undefined,
		wake: browserWake,
	});
}

/** Retries when the browser reports it is online again or the tab becomes visible. */
function browserWake(retry: () => void): () => void {
	const onVisible = () => {
		if (document.visibilityState === "visible") retry();
	};
	window.addEventListener("online", retry);
	document.addEventListener("visibilitychange", onVisible);
	return () => {
		window.removeEventListener("online", retry);
		document.removeEventListener("visibilitychange", onVisible);
	};
}
