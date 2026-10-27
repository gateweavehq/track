import type { Op, Snapshot } from "@gateweave/track-protocol";
import type { PendingMutation } from "./store";

export interface StoredReplica {
	/** Identifies this device to the server. Created on first use and kept with the data. */
	clientId: string;
	/** Confirmed state, or null if the workspace has never been synced here. */
	snapshot: Snapshot | null;
	/** Unconfirmed mutations, in the order they were made. */
	pending: PendingMutation[];
}

/**
 * Durable storage for a workspace replica. Storage is a cache of server state plus the queue of
 * unsent mutations; the server stays the source of truth. Writes take effect in call order.
 */
export interface Persistence {
	/**
	 * True if every tab of this browser reads and writes the same storage. Shared storage lets
	 * tabs elect one of them to hold the connection for all.
	 */
	readonly shared: boolean;
	load(): Promise<StoredReplica>;
	/** Replaces the confirmed state. Pending mutations are kept. */
	replace(snapshot: Snapshot): Promise<void>;
	/** Applies ops and records `version` as the confirmed version, atomically. */
	applyOps(ops: readonly Op[], version: number): Promise<void>;
	addPending(mutation: PendingMutation): Promise<void>;
	removePending(id: string): Promise<void>;
	close(): void;
}

/** Keeps the replica in memory only. Used where IndexedDB is unavailable, and in tests. */
export class MemoryPersistence implements Persistence {
	readonly shared = false;
	#clientId = crypto.randomUUID();
	#snapshot: Snapshot | null = null;
	#pending: PendingMutation[] = [];

	async load(): Promise<StoredReplica> {
		return {
			clientId: this.#clientId,
			snapshot: this.#snapshot && structuredClone(this.#snapshot),
			pending: structuredClone(this.#pending),
		};
	}

	async replace(snapshot: Snapshot): Promise<void> {
		this.#snapshot = structuredClone(snapshot);
	}

	async applyOps(ops: readonly Op[], version: number): Promise<void> {
		const snapshot = this.#snapshot;
		if (!snapshot) throw new Error("Cannot apply ops before a snapshot is stored");
		for (const op of ops) {
			const key = `${op.entity}s` as "teams" | "issues" | "labels" | "members";
			const rows = snapshot[key].filter((row) => row.id !== op.id);
			if (op.op === "put") rows.push(structuredClone(op.data) as never);
			snapshot[key] = rows as never;
		}
		snapshot.version = version;
	}

	async addPending(mutation: PendingMutation): Promise<void> {
		this.#pending.push(structuredClone(mutation));
	}

	async removePending(id: string): Promise<void> {
		this.#pending = this.#pending.filter((p) => p.id !== id);
	}

	close(): void {}
}
