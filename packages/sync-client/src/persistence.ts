import { type Op, SNAPSHOT_KEYS, type Snapshot } from "@gateweave/track-protocol";
import type { PendingMutation } from "./store";

export interface StoredReplica {
	/** Identifies this device to the server. Created on first use and kept with the data. */
	clientId: string;
	/** Confirmed state, or null if the workspace has never been synced here. */
	snapshot: Snapshot | null;
	/** Unconfirmed mutations, in the order they were made. */
	pending: PendingMutation[];
	/** Rows whose stored shape cannot be read by this build. */
	unreadable: { id?: string; seq?: number; name: string; args: Record<string, unknown> }[];
}

export class PendingFormatError extends Error {
	constructor(format: unknown) {
		const label =
			typeof format === "string" || typeof format === "number" || typeof format === "boolean"
				? String(format)
				: "unknown";
		super(`This version of Track cannot read changes stored in pending format ${label}`);
		this.name = "PendingFormatError";
	}
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
	/** Stores mutations in order, in one write. */
	addPending(...mutations: PendingMutation[]): Promise<void>;
	/** Returns whether a row was actually removed. A number addresses a row without an id by seq. */
	removePending(id: string | number): Promise<boolean>;
	/** A newer tab needs this database closed after queued client writes finish. */
	onTaken?(listener: () => void): void;
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
			unreadable: [],
		};
	}

	async replace(snapshot: Snapshot): Promise<void> {
		this.#snapshot = structuredClone(snapshot);
	}

	async applyOps(ops: readonly Op[], version: number): Promise<void> {
		const snapshot = this.#snapshot;
		if (!snapshot) throw new Error("Cannot apply ops before a snapshot is stored");
		for (const op of ops) {
			const key = SNAPSHOT_KEYS[op.entity];
			const rows = (snapshot[key] as { id: string }[]).filter((row) => row.id !== op.id);
			if (op.op === "put") rows.push(structuredClone(op.data) as never);
			snapshot[key] = rows as never;
		}
		snapshot.version = version;
	}

	async addPending(...mutations: PendingMutation[]): Promise<void> {
		for (const mutation of mutations) this.#pending.push(structuredClone(mutation));
	}

	async removePending(id: string | number): Promise<boolean> {
		if (typeof id === "number") return false;
		const before = this.#pending.length;
		this.#pending = this.#pending.filter((p) => p.id !== id);
		return this.#pending.length !== before;
	}

	close(): void {}
}
