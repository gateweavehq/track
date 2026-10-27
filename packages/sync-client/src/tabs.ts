import type { Op, RejectReason } from "@gateweave/track-protocol";
import type { PendingMutation } from "./store";

export type ConnectionStatus =
	/** Opening the socket or catching up. */
	| "connecting"
	/** Caught up and receiving changes as they happen. */
	| "live"
	/** Disconnected; retrying with backoff. Local edits are queued. */
	| "offline"
	/** The server speaks a newer protocol. The page must be reloaded. */
	| "outdated"
	/** The session has ended. The user must sign in again. */
	| "unauthorized"
	/** The user is not a member of the workspace, or it no longer exists. */
	| "forbidden";

/** Messages between tabs that share a replica. */
export type TabMessage =
	/** A tab made a mutation. Every tab applies it optimistically; the leader sends it. */
	| { type: "mutation"; pending: PendingMutation }
	/** The leader stored new server ops. */
	| { type: "ops"; ops: Op[] }
	| { type: "ack"; id: string; version: number }
	| { type: "reject"; id: string; reason: RejectReason; message?: string }
	/** The leader replaced the stored state with a snapshot. Followers reload from storage. */
	| { type: "reload" }
	| { type: "status"; connection: ConnectionStatus }
	/** A follower asks the leader for its connection status. */
	| { type: "status?" };

/**
 * Coordinates the tabs that share one replica so that only one of them, the leader, holds a
 * connection. The others follow along through messages and shared storage.
 */
export interface Tabs {
	/** Calls `onLeader` once this tab is elected. Tabs are elected one at a time, in order. */
	elect(onLeader: () => void): void;
	/** Sends a message to every other tab. */
	post(message: TabMessage): void;
	subscribe(handler: (message: TabMessage) => void): void;
	/** Leaves the group. If this tab was the leader, the next tab is elected. */
	close(): void;
}

/** A tab that coordinates with no one: it leads on its own. */
export function standaloneTabs(): Tabs {
	return {
		elect: (onLeader) => queueMicrotask(onLeader),
		post() {},
		subscribe() {},
		close() {},
	};
}

/** True if this browser can coordinate tabs with `browserTabs`. */
export function supportsBrowserTabs(): boolean {
	return typeof BroadcastChannel !== "undefined" && typeof navigator?.locks?.request === "function";
}

/** Elects a leader with the Web Locks API and messages other tabs over a BroadcastChannel. */
export function browserTabs(name: string): Tabs {
	const channel = new BroadcastChannel(name);
	const abort = new AbortController();
	let release: (() => void) | undefined;

	return {
		elect(onLeader) {
			navigator.locks
				.request(name, { signal: abort.signal }, () => {
					onLeader();
					// Hold the lock, and with it the leadership, until this tab closes.
					return new Promise<void>((resolve) => {
						release = resolve;
					});
				})
				// Rejects with an AbortError if the tab closes while still waiting.
				.catch(() => {});
		},
		post(message) {
			channel.postMessage(message);
		},
		subscribe(handler) {
			channel.onmessage = (event: MessageEvent<TabMessage>) => handler(event.data);
		},
		close() {
			abort.abort();
			release?.();
			channel.close();
		},
	};
}
