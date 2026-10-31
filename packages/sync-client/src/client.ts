import {
	type ClientMessage,
	CloseCode,
	type Mutation,
	type MutationInput,
	mutationSchema,
	PING,
	PONG,
	PROTOCOL_VERSION,
	type RejectReason,
	type ServerMessage,
	type Snapshot,
} from "@gateweave/track-protocol";
import { MemoryPersistence, type Persistence, type StoredReplica } from "./persistence";
import { type Delta, type PendingMutation, Replica, type SyncState } from "./store";
import { type ConnectionStatus, standaloneTabs, type TabMessage, type Tabs } from "./tabs";
import { HttpError, type SyncSocket, type Transport } from "./transport";

export interface SyncStatus {
	/** The connection to the server, as seen by whichever tab holds it. */
	readonly connection: ConnectionStatus;
	/** True once there is data to show, from local storage or from the server. */
	readonly loaded: boolean;
	/** Mutations the server has not confirmed yet, from every tab of this browser. */
	readonly pending: number;
}

/** The server rejected a mutation. Its optimistic effect has been rolled back. */
export class MutationError extends Error {
	constructor(
		readonly reason: RejectReason,
		message: string,
		readonly mutation: Mutation,
	) {
		super(message);
		this.name = "MutationError";
	}
}

export interface SyncClientOptions {
	/** The signed-in user. Optimistic issues are attributed to them. */
	userId: string;
	transport: Transport;
	/** Where the replica is kept between sessions. Defaults to memory. */
	persistence?: Persistence | Promise<Persistence>;
	/** Coordination with other tabs. Only used when `persistence` is shared between tabs. */
	tabs?: Tabs;
	/**
	 * Called when the server rejects a mutation made in this tab. Mutations restored from storage,
	 * whose tab is gone, are reported by the tab that holds the connection.
	 */
	onReject?: (error: MutationError) => void;
	/**
	 * Subscribes to signals that the network may be back, such as the browser going online. The
	 * client then retries right away instead of waiting out its backoff.
	 */
	wake?: (retry: () => void) => () => void;
	retry?: { minDelay?: number; maxDelay?: number };
	keepalive?: { interval?: number; timeout?: number };
}

interface Waiter {
	resolve(version: number): void;
	reject(error: MutationError): void;
}

const FATAL: ReadonlySet<ConnectionStatus> = new Set(["outdated", "unauthorized", "forbidden"]);

/**
 * Keeps a local replica of one workspace in sync with its Durable Object.
 *
 * Reads are synchronous and come from memory. Mutations apply optimistically, are stored until
 * the server confirms them, and survive reloads and offline periods. When storage is shared, the
 * tabs of a browser elect one leader that holds the only connection; the others apply what it
 * broadcasts and hand it their mutations.
 */
export class SyncClient {
	readonly #options: SyncClientOptions;
	readonly #replica: Replica;
	readonly #started: Promise<void>;
	#persistence: Persistence = new MemoryPersistence();
	#tabs: Tabs = standaloneTabs();
	#clientId = "";
	#role: "starting" | "follower" | "leader" | "closed" = "starting";
	#status: SyncStatus = { connection: "connecting", loaded: false, pending: 0 };
	readonly #statusListeners = new Set<() => void>();
	/** Settles the promises returned by `mutate()` in this tab. */
	readonly #waiters = new Map<string, Waiter>();
	/** Mutations this tab loaded from storage at startup. */
	readonly #restored = new Set<string>();
	/** Tab messages held back while state loads from storage, replayed afterwards. */
	#held: TabMessage[] | null = [];
	/** Storage writes, each followed by the tab message that announces it. Runs in order. */
	#writes: Promise<void>;
	/** A state write failed. The next one rewrites the whole state from memory. */
	#storageDirty = false;
	#unwake?: () => void;

	// Connection state. Only the leader connects.
	#socket: SyncSocket | null = null;
	/** Incremented whenever the connection is torn down, so stale callbacks can tell. */
	#generation = 0;
	#live = false;
	/** Mutations sent on the current socket. Unacknowledged ones are resent on the next. */
	readonly #sent = new Set<string>();
	#attempt = 0;
	#needsSnapshot = false;
	#retryTimer?: ReturnType<typeof setTimeout>;
	#pingTimer?: ReturnType<typeof setInterval>;
	#pongTimer?: ReturnType<typeof setTimeout>;

	constructor(options: SyncClientOptions) {
		this.#options = options;
		this.#replica = new Replica(options.userId);
		this.#replica.subscribe(() => this.#setStatus({ pending: this.#replica.pending.length }));
		this.#started = this.#start();
		this.#writes = this.#started.catch(() => {});
	}

	getState = (): SyncState => this.#replica.getState();

	subscribe = (listener: () => void): (() => void) => this.#replica.subscribe(listener);

	getStatus = (): SyncStatus => this.#status;

	subscribeStatus = (listener: () => void): (() => void) => {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	};

	/**
	 * Applies a mutation locally and queues it for the server. Throws if the mutation is invalid.
	 * The returned promise resolves with the server version once the server has applied it, and
	 * rejects with a `MutationError` if the server refuses it. The UI does not need to wait for it.
	 */
	mutate(input: MutationInput): Promise<number> {
		if (this.#role === "closed") throw new Error("This SyncClient is closed");
		// Validate exactly what the server will receive: JSON drops undefined fields.
		const mutation = mutationSchema.parse(JSON.parse(JSON.stringify(input)));
		const pending: PendingMutation = { id: crypto.randomUUID(), mutation, createdAt: Date.now() };

		const confirmed = new Promise<number>((resolve, reject) => {
			this.#waiters.set(pending.id, { resolve, reject });
		});
		// Callers may ignore the promise; rejections are also reported through `onReject`.
		confirmed.catch(() => {});

		this.#replica.addPending(pending);
		this.#write((p) => p.addPending(pending), { type: "mutation", pending });
		this.#send(pending);
		return confirmed;
	}

	/** Retries now instead of waiting out the backoff, and checks a live connection is still up. */
	retryNow = (): void => {
		if (this.#role !== "leader" || FATAL.has(this.#status.connection)) return;
		if (this.#live) this.#ping();
		else if (!this.#socket) {
			this.#attempt = 0;
			void this.#connect();
		}
	};

	/** Disconnects, finishes pending storage writes and leaves the tab group. */
	async close(): Promise<void> {
		if (this.#role === "closed") return;
		this.#role = "closed";
		this.#disconnect();
		clearTimeout(this.#retryTimer);
		this.#unwake?.();
		await this.#started.catch(() => {});
		await this.#writes;
		this.#tabs.close();
		this.#persistence.close();
	}

	// Startup and tab coordination

	async #start(): Promise<void> {
		let persistence: Persistence;
		try {
			persistence = await (this.#options.persistence ?? new MemoryPersistence());
		} catch (error) {
			console.warn("sync: local storage is unavailable; keeping data in memory", error);
			persistence = new MemoryPersistence();
		}
		this.#persistence = persistence;
		if (persistence.shared && this.#options.tabs) this.#tabs = this.#options.tabs;
		else this.#options.tabs?.close();
		// Subscribe before loading so nothing announced during the load is missed.
		this.#tabs.subscribe((message) => this.#onTabMessage(message));

		let stored: StoredReplica;
		try {
			stored = await persistence.load();
		} catch (error) {
			console.warn("sync: could not read local storage; keeping data in memory", error);
			persistence.close();
			this.#tabs.close();
			this.#persistence = new MemoryPersistence();
			this.#tabs = standaloneTabs();
			stored = await this.#persistence.load();
		}
		if (this.#role === "closed") return;

		this.#clientId = stored.clientId;
		for (const { id } of stored.pending) this.#restored.add(id);
		this.#load(stored);
		this.#role = "follower";
		this.#releaseHeld();
		this.#unwake = this.#options.wake?.(this.retryNow);
		this.#tabs.elect(() => this.#lead());
		this.#tabs.post({ type: "status?" });
	}

	#load(stored: StoredReplica): void {
		if (stored.snapshot) this.#replica.reset(stored.snapshot, { onlyIfNewer: true });
		this.#replica.addPending(...stored.pending);
		if (this.#replica.hasData) this.#setStatus({ loaded: true });
	}

	/** Re-reads shared storage after this follower fell behind or the leader replaced it. */
	async #reload(): Promise<void> {
		if (this.#held) return;
		this.#held = [];
		try {
			this.#load(await this.#persistence.load());
		} catch (error) {
			console.warn("sync: could not reload local storage", error);
		} finally {
			this.#releaseHeld();
		}
	}

	#releaseHeld(): void {
		const held = this.#held ?? [];
		this.#held = null;
		for (const message of held) this.#onTabMessage(message);
	}

	#onTabMessage(message: TabMessage): void {
		if (this.#role === "closed") return;
		if (this.#held) {
			this.#held.push(message);
			return;
		}
		switch (message.type) {
			case "mutation":
				this.#replica.addPending(message.pending);
				this.#send(message.pending);
				return;
			case "status?":
				if (this.#role === "leader") {
					this.#tabs.post({ type: "status", connection: this.#status.connection });
				}
				return;
		}
		// The leader hears from the server directly. Anything else reaching it is from a previous
		// leader, and its own catch-up covers it.
		if (this.#role === "leader") return;
		switch (message.type) {
			case "delta":
				if (!this.#replica.applyDelta(message)) void this.#reload();
				return;
			case "reload":
				void this.#reload();
				return;
			case "ack":
				this.#settle(message.id, message.version);
				return;
			case "reject":
				this.#rejected(message.id, message.reason, message.message);
				return;
			case "status":
				this.#setStatus({ connection: message.connection });
				return;
		}
	}

	#lead(): void {
		if (this.#role === "closed") return;
		this.#role = "leader";
		void this.#connect();
	}

	// Connection

	async #connect(): Promise<void> {
		if (this.#role !== "leader") return;
		clearTimeout(this.#retryTimer);
		this.#disconnect();
		const generation = this.#generation;
		const current = () => generation === this.#generation;
		this.#setConnection("connecting");

		if (!this.#replica.hasData || this.#needsSnapshot) {
			try {
				const snapshot = await this.#options.transport.snapshot();
				if (!current()) return;
				this.#applySnapshot(snapshot);
				this.#needsSnapshot = false;
			} catch (error) {
				if (current()) this.#connectFailed(error);
				return;
			}
		}

		let opened = false;
		this.#socket = this.#options.transport.connect({
			open: () => {
				if (!current()) return;
				opened = true;
				this.#hello();
			},
			message: (data) => {
				if (current()) this.#onServerMessage(data);
			},
			close: (code) => {
				if (current()) this.#onSocketClosed(code, opened);
			},
		});
	}

	#hello(): void {
		this.#sendRaw({
			type: "hello",
			protocol: PROTOCOL_VERSION,
			clientId: this.#clientId,
			since: this.#replica.version,
		});
	}

	#onServerMessage(data: string): void {
		if (data === PONG) {
			clearTimeout(this.#pongTimer);
			this.#pongTimer = undefined;
			return;
		}
		let message: ServerMessage;
		try {
			message = JSON.parse(data) as ServerMessage;
		} catch {
			this.#reconnect();
			return;
		}
		switch (message.type) {
			case "delta":
				this.#applyServerDelta(message);
				return;
			case "ready":
				this.#live = true;
				this.#attempt = 0;
				this.#setConnection("live");
				this.#startKeepalive();
				for (const pending of this.#replica.pending) this.#send(pending);
				return;
			case "ack": {
				const { id, version } = message;
				this.#write((p) => p.removePending(id), { type: "ack", id, version });
				this.#settle(id, version);
				return;
			}
			case "reject": {
				const { id } = message;
				this.#write((p) => p.removePending(id), message);
				this.#rejected(id, message.reason, message.message);
				return;
			}
			case "reset":
				void this.#resync();
				return;
		}
	}

	#applyServerDelta({ from, to, ops }: Delta): void {
		if (!this.#replica.applyDelta({ from, to, ops })) {
			// Never expected from a direct connection, but a gap cannot be repaired incrementally.
			this.#needsSnapshot = true;
			this.#reconnect();
			return;
		}
		const version = this.#replica.version;
		this.#write((p) => p.applyOps(ops, version), { type: "delta", from, to, ops }, { state: true });
	}

	#applySnapshot(snapshot: Snapshot): void {
		this.#replica.reset(snapshot);
		this.#setStatus({ loaded: true });
		this.#write((p) => p.replace(snapshot), { type: "reload" }, { state: true });
	}

	/** The server cannot catch this replica up incrementally: start over from a snapshot. */
	async #resync(): Promise<void> {
		const generation = this.#generation;
		try {
			const snapshot = await this.#options.transport.snapshot();
			if (generation !== this.#generation) return;
			this.#applySnapshot(snapshot);
			this.#hello();
		} catch (error) {
			if (generation !== this.#generation) return;
			this.#disconnect();
			this.#connectFailed(error);
		}
	}

	#onSocketClosed(code: number, opened: boolean): void {
		this.#disconnect();
		if (code === CloseCode.ProtocolMismatch) this.#fail("outdated");
		else if (code === CloseCode.Forbidden) this.#fail("forbidden");
		else if (opened) this.#scheduleRetry();
		else void this.#probe();
	}

	/** Finds out why a socket could not be opened: offline, signed out, or no longer a member. */
	async #probe(): Promise<void> {
		const generation = this.#generation;
		this.#setConnection("offline");
		try {
			await this.#options.transport.probe();
			if (generation === this.#generation) this.#scheduleRetry();
		} catch (error) {
			if (generation === this.#generation) this.#connectFailed(error);
		}
	}

	#connectFailed(error: unknown): void {
		const status = error instanceof HttpError ? error.status : 0;
		if (status === 401) this.#fail("unauthorized");
		else if (status === 403 || status === 404) this.#fail("forbidden");
		else this.#scheduleRetry();
	}

	#scheduleRetry(): void {
		if (this.#role !== "leader") return;
		this.#setConnection("offline");
		const { minDelay = 500, maxDelay = 30_000 } = this.#options.retry ?? {};
		const ceiling = Math.min(maxDelay, minDelay * 2 ** this.#attempt);
		this.#attempt += 1;
		// Half fixed, half random, so clients that lost the same server do not return in lockstep.
		const delay = ceiling / 2 + (Math.random() * ceiling) / 2;
		clearTimeout(this.#retryTimer);
		this.#retryTimer = setTimeout(() => void this.#connect(), delay);
	}

	#reconnect(): void {
		this.#disconnect();
		this.#scheduleRetry();
	}

	#fail(connection: ConnectionStatus): void {
		this.#disconnect();
		clearTimeout(this.#retryTimer);
		this.#setConnection(connection);
	}

	/** Drops the current socket, if any, and invalidates its pending callbacks. */
	#disconnect(): void {
		this.#generation += 1;
		const socket = this.#socket;
		this.#socket = null;
		this.#live = false;
		this.#sent.clear();
		this.#stopKeepalive();
		try {
			socket?.close(1000, "Client disconnected");
		} catch {
			// Already closed.
		}
	}

	#startKeepalive(): void {
		this.#stopKeepalive();
		const { interval = 30_000 } = this.#options.keepalive ?? {};
		this.#pingTimer = setInterval(() => this.#ping(), interval);
	}

	#stopKeepalive(): void {
		clearInterval(this.#pingTimer);
		clearTimeout(this.#pongTimer);
		this.#pongTimer = undefined;
	}

	/** Sends a ping. A connection that does not answer in time is treated as lost. */
	#ping(): void {
		if (!this.#live || this.#pongTimer !== undefined) return;
		const { timeout = 10_000 } = this.#options.keepalive ?? {};
		this.#sendRaw(PING);
		this.#pongTimer = setTimeout(() => {
			this.#pongTimer = undefined;
			this.#reconnect();
		}, timeout);
	}

	#send(pending: PendingMutation): void {
		if (this.#role !== "leader" || !this.#live || this.#sent.has(pending.id)) return;
		this.#sent.add(pending.id);
		this.#sendRaw({ type: "mutate", id: pending.id, mutation: pending.mutation });
	}

	#sendRaw(message: ClientMessage | string): void {
		try {
			this.#socket?.send(typeof message === "string" ? message : JSON.stringify(message));
		} catch {
			// The socket is closing. Unacknowledged mutations are resent after reconnecting.
		}
	}

	// Mutation results

	#settle(id: string, version: number): void {
		this.#replica.removePending(id);
		this.#sent.delete(id);
		this.#restored.delete(id);
		const waiter = this.#waiters.get(id);
		this.#waiters.delete(id);
		waiter?.resolve(version);
	}

	#rejected(id: string, reason: RejectReason, message: string | undefined): void {
		const pending = this.#replica.removePending(id);
		this.#sent.delete(id);
		const restored = this.#restored.delete(id);
		const waiter = this.#waiters.get(id);
		this.#waiters.delete(id);
		if (!pending) return;

		const error = new MutationError(reason, message ?? reason, pending.mutation);
		waiter?.reject(error);
		if (waiter || (restored && this.#role === "leader")) this.#options.onReject?.(error);
	}

	// Storage and status

	/**
	 * Queues a storage write, then announces it to the other tabs. Announcing only after the write
	 * means a tab that reloads from storage always finds at least what it has been told about.
	 */
	#write(
		write: (persistence: Persistence) => Promise<void>,
		message?: TabMessage,
		{ state = false } = {},
	): void {
		this.#writes = this.#writes.then(async () => {
			try {
				if (state && this.#storageDirty) {
					await this.#persistence.replace(this.#replica.snapshot());
					this.#storageDirty = false;
				} else {
					await write(this.#persistence);
				}
			} catch (error) {
				if (state) this.#storageDirty = true;
				console.warn("sync: could not write to local storage", error);
			}
			if (message) {
				try {
					this.#tabs.post(message);
				} catch {
					// The tab group is already closed.
				}
			}
		});
	}

	#setConnection(connection: ConnectionStatus): void {
		if (this.#setStatus({ connection }) && this.#role === "leader") {
			this.#tabs.post({ type: "status", connection });
		}
	}

	#setStatus(patch: Partial<SyncStatus>): boolean {
		const next = { ...this.#status, ...patch };
		if (
			next.connection === this.#status.connection &&
			next.loaded === this.#status.loaded &&
			next.pending === this.#status.pending
		) {
			return false;
		}
		this.#status = next;
		for (const listener of [...this.#statusListeners]) listener();
		return true;
	}
}
