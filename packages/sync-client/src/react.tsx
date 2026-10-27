import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";
import type { SyncClient, SyncStatus } from "./client";
import type { SyncState } from "./store";

const SyncClientContext = createContext<SyncClient | null>(null);

export function SyncProvider({ client, children }: { client: SyncClient; children: ReactNode }) {
	return <SyncClientContext value={client}>{children}</SyncClientContext>;
}

export function useSyncClient(): SyncClient {
	const client = useContext(SyncClientContext);
	if (!client) throw new Error("useSyncClient must be used inside <SyncProvider>");
	return client;
}

/**
 * Selects a value from the synced state and re-renders when it changes. The component only
 * re-renders when `isEqual` says the selection changed, so a selector that builds a new array
 * should pass `shallowEqual`. Rows keep their identity until they change, which makes shallow
 * comparison cheap and exact. Keep `select` stable (or memoized) for the best performance.
 */
export function useQuery<T>(
	select: (state: SyncState) => T,
	isEqual: (a: T, b: T) => boolean = Object.is,
): T {
	const client = useSyncClient();
	const getSelection = useMemo(() => {
		let last: { state: SyncState; value: T } | undefined;
		return () => {
			const state = client.getState();
			if (last?.state === state) return last.value;
			const next = select(state);
			const value = last && isEqual(last.value, next) ? last.value : next;
			last = { state, value };
			return value;
		};
	}, [client, select, isEqual]);
	return useSyncExternalStore(client.subscribe, getSelection, getSelection);
}

export function useSyncStatus(): SyncStatus {
	const client = useSyncClient();
	return useSyncExternalStore(client.subscribeStatus, client.getStatus, client.getStatus);
}

/** True if both arrays hold the same items in the same order. */
export function shallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}
