// Files attached while offline, or while an upload could not get through, wait here and upload
// when the connection comes back, as mutations do in the replica's queue. The link is in the text
// from the start; this keeps the file until the gateway has it. The gateway refuses an id in use,
// so sending a file twice, from a retry or from two tabs, leaves it as it was (409). Other members
// see the link before the file is up, though, and an id someone else stored a file under first
// (412) does not hold this file: that upload failed, and the person keeps their copy to attach
// again.
//
// One browser can be signed in as different people over time, and the outbox outlives a session
// that expires without a sign-out. Each file remembers who attached it, and only goes up while
// that person is signed in, never under someone else's session.

/** A file waiting to upload. Its path names the workspace and the file's id. */
export interface PendingUpload {
	path: string;
	workspaceId: string;
	/** Who attached it: only their session uploads it. */
	userId: string;
	name: string;
	type: string;
	blob: Blob;
	createdAt: number;
}

/** Where pending uploads are kept: IndexedDB in the browser, memory in tests. */
export interface OutboxStore {
	all(): Promise<PendingUpload[]>;
	put(upload: PendingUpload): Promise<void>;
	delete(path: string): Promise<void>;
	clear(workspaceId?: string): Promise<void>;
}

/**
 * What became of an upload: on the server, still waiting, or refused for good. `taken` says the
 * link holds someone else's file, so the text shows theirs until it links this one again.
 */
export type UploadResult =
	| { status: "uploaded" }
	| { status: "waiting" }
	| { status: "failed"; message: string; taken?: true };

/** A file refused for good, of several attached together, with why. */
export interface Refusal<T> {
	item: T;
	message: string;
	/** Its link holds someone else's file, so the person's copy is all that is left of it. */
	taken: boolean;
}

/**
 * The files attached together that were refused for good, in order, each with its outcome. Every
 * one is reported, not only the first: each refused because its link is taken needs its copy
 * offered, or the file is gone.
 */
export function refusals<T>(items: readonly T[], outcomes: readonly UploadResult[]): Refusal<T>[] {
	return outcomes.flatMap((outcome, index) => {
		const item = items[index];
		if (outcome.status !== "failed" || item === undefined) return [];
		return [{ item, message: outcome.message, taken: outcome.taken === true }];
	});
}

/**
 * Hears what became of an upload. `first` is true for the first try of a file just added, whose
 * outcome its `add` already reports; false for one that waited, from this visit or an earlier one.
 */
type Settled = (upload: PendingUpload, result: UploadResult, first: boolean) => void;

export class UploadOutbox {
	readonly #store: OutboxStore;
	readonly #fetch: typeof fetch;
	readonly #lock: (run: () => Promise<void>) => Promise<void>;
	/** Paths waiting, with a URL that shows the file from this device meanwhile. */
	#pending = new Map<string, string | null>();
	#listeners = new Set<() => void>();
	#settled = new Set<Settled>();
	#loaded: Promise<void> | null = null;
	#draining: Promise<void> | null = null;
	/** A file came while a drain was under way, after it read what was waiting. */
	#again = false;
	/** Files added and not tried yet. */
	#fresh = new Set<string>();
	/** Who is signed in: only their files are shown as waiting and uploaded. */
	#userId: string | null = null;
	readonly #preview: (blob: Blob) => string | null;

	constructor({
		store,
		fetch: send = (...args) => fetch(...args),
		lock = (run) => run(),
		preview = () => null,
	}: {
		store: OutboxStore;
		fetch?: typeof fetch;
		/** Runs a drain alone among the browser's tabs. */
		lock?: (run: () => Promise<void>) => Promise<void>;
		/** A URL to show a waiting file with, such as an object URL. */
		preview?: (blob: Blob) => string | null;
	}) {
		this.#store = store;
		this.#fetch = send;
		this.#lock = lock;
		this.#preview = preview;
	}

	/**
	 * Says who is signed in. Only their files upload; anyone else's wait until they sign in
	 * again on this browser, or are deleted when someone signs out.
	 */
	setUser(userId: string | null): void {
		if (userId === this.#userId) return;
		this.#userId = userId;
		this.#loaded = null;
		for (const path of [...this.#pending.keys()]) this.#unmark(path);
	}

	/** Keeps a file to upload and tries at once. Resolves with what became of it this time. */
	async add(upload: PendingUpload): Promise<UploadResult> {
		this.setUser(upload.userId);
		await this.#store.put(upload);
		this.#fresh.add(upload.path);
		this.#mark(upload);
		const result = new Promise<UploadResult>((resolve) => {
			const settled: Settled = (done, outcome) => {
				if (done.path !== upload.path) return;
				this.#settled.delete(settled);
				resolve(outcome);
			};
			this.#settled.add(settled);
		});
		void this.drain();
		return result;
	}

	/**
	 * Uploads what is waiting, oldest first, and stops at the first one the network or the server
	 * cannot take now. Each upload's outcome goes to `onSettled` listeners.
	 */
	drain(): Promise<void> {
		if (this.#draining) {
			this.#again = true;
			return this.#draining;
		}
		this.#draining = (async () => {
			do {
				this.#again = false;
				await this.#lock(() => this.#drainAll()).catch(() => {});
			} while (this.#again);
			this.#draining = null;
		})();
		return this.#draining;
	}

	async #drainAll(): Promise<void> {
		await this.load();
		const waiting = (await this.#store.all())
			.filter((upload) => upload.userId === this.#userId)
			.sort((a, b) => a.createdAt - b.createdAt);
		let stopped = false;
		for (const upload of waiting) {
			if (stopped) {
				this.#emit(upload, { status: "waiting" });
				continue;
			}
			const result = await this.#send(upload);
			if (result.status === "waiting") stopped = true;
			else {
				await this.#store.delete(upload.path);
				this.#unmark(upload.path);
			}
			this.#emit(upload, result);
		}
	}

	async #send(upload: PendingUpload): Promise<UploadResult> {
		let response: Response;
		try {
			response = await this.#fetch(upload.path, {
				method: "PUT",
				body: upload.blob,
				headers: { "Content-Type": upload.type || "application/octet-stream" },
			});
		} catch {
			// No connection, or it dropped: the file waits.
			return { status: "waiting" };
		}
		// 409: this person's file is there already, from an earlier try or another tab. Someone
		// else's file at the link answers 412, a failure like any refusal for good.
		if (response.ok || response.status === 409) return { status: "uploaded" };
		// The server is busy or down for now, or the session ran out while the file waited and it
		// goes up once its owner signs in again. Anything else will be refused again.
		if (response.status >= 500 || response.status === 429 || response.status === 401) {
			return { status: "waiting" };
		}
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		return {
			status: "failed",
			message: `${body?.error ?? `The server answered ${response.status}`}.`,
			...(response.status === 412 && { taken: true as const }),
		};
	}

	/** Reads what an earlier visit left waiting, once. */
	load(): Promise<void> {
		if (!this.#loaded) {
			this.#loaded = this.#store
				.all()
				.then((uploads) => {
					for (const upload of uploads) {
						if (upload.userId === this.#userId) this.#mark(upload);
					}
				})
				.catch(() => {});
		}
		return this.#loaded;
	}

	/** Forgets what waits, for one workspace or all of them, as when leaving it or signing out. */
	async clear(workspaceId?: string): Promise<void> {
		const all = await this.#store.all().catch(() => []);
		await this.#store.clear(workspaceId);
		for (const upload of all) {
			if (workspaceId === undefined || upload.workspaceId === workspaceId) {
				this.#unmark(upload.path);
			}
		}
	}

	/** Hears what became of each upload a drain tried or left waiting. */
	onSettled(listener: Settled): () => void {
		this.#settled.add(listener);
		return () => this.#settled.delete(listener);
	}

	/** Whether a path's file is waiting to upload, and a URL that shows it meanwhile. */
	pending(path: string): { waiting: boolean; preview: string | null } {
		return { waiting: this.#pending.has(path), preview: this.#pending.get(path) ?? null };
	}

	get size(): number {
		return this.#pending.size;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#mark(upload: PendingUpload) {
		if (this.#pending.has(upload.path)) return;
		this.#pending = new Map(this.#pending).set(upload.path, this.#preview(upload.blob));
		this.#changed();
	}

	#unmark(path: string) {
		const preview = this.#pending.get(path);
		if (!this.#pending.has(path)) return;
		const next = new Map(this.#pending);
		next.delete(path);
		this.#pending = next;
		if (preview) URL.revokeObjectURL?.(preview);
		this.#changed();
	}

	#changed() {
		for (const listener of [...this.#listeners]) listener();
	}

	#emit(upload: PendingUpload, result: UploadResult) {
		const first = this.#fresh.delete(upload.path);
		for (const listener of [...this.#settled]) listener(upload, result, first);
	}
}

/** The outbox in memory, for tests and for browsers without IndexedDB. */
export function memoryOutboxStore(): OutboxStore {
	const uploads = new Map<string, PendingUpload>();
	return {
		all: async () => [...uploads.values()],
		put: async (upload) => void uploads.set(upload.path, upload),
		delete: async (path) => void uploads.delete(path),
		clear: async (workspaceId) => {
			for (const [path, upload] of uploads) {
				if (workspaceId === undefined || upload.workspaceId === workspaceId) uploads.delete(path);
			}
		},
	};
}

const DB_NAME = "track-uploads";
const STORE = "uploads";

/** The outbox in IndexedDB: one database for the browser, a record per file, keyed by path. */
export function idbOutboxStore(): OutboxStore {
	let opened: Promise<IDBDatabase> | null = null;
	const open = () => {
		opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "path" });
			request.onsuccess = () => {
				const db = request.result;
				// Signing out deletes the database; this tab lets go so the delete can finish.
				db.onversionchange = () => {
					db.close();
					opened = null;
				};
				resolve(db);
			};
			request.onerror = () => reject(request.error);
		});
		return opened;
	};
	const run = async <T>(
		mode: IDBTransactionMode,
		work: (store: IDBObjectStore) => IDBRequest<T> | undefined,
	): Promise<T | undefined> => {
		const db = await open();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const request = work(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(request?.result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	};
	return {
		all: async () => ((await run("readonly", (store) => store.getAll())) ?? []) as PendingUpload[],
		put: async (upload) => void (await run("readwrite", (store) => store.put(upload))),
		delete: async (path) => void (await run("readwrite", (store) => store.delete(path))),
		clear: async (workspaceId) => {
			if (workspaceId === undefined) {
				await run("readwrite", (store) => store.clear());
				return;
			}
			const all = ((await run("readonly", (store) => store.getAll())) ?? []) as PendingUpload[];
			await run("readwrite", (store) => {
				for (const upload of all) {
					if (upload.workspaceId === workspaceId) store.delete(upload.path);
				}
				return undefined;
			});
		},
	};
}

/** Deletes the outbox's database, as signing out does. */
export function deleteOutboxDatabase(): Promise<void> {
	return new Promise((resolve) => {
		const request = indexedDB.deleteDatabase(DB_NAME);
		request.onsuccess = () => resolve();
		request.onerror = () => resolve();
		request.onblocked = () => resolve();
	});
}

let shared: UploadOutbox | null = null;

/** The browser's outbox, shared by every text box that attaches files. */
export function uploadOutbox(): UploadOutbox {
	shared ??= new UploadOutbox({
		store: typeof indexedDB === "undefined" ? memoryOutboxStore() : idbOutboxStore(),
		lock: (run) =>
			typeof navigator !== "undefined" && navigator.locks
				? navigator.locks.request("track:upload-outbox", run)
				: run(),
		preview: (blob) =>
			blob.type.startsWith("image/") && typeof URL.createObjectURL === "function"
				? URL.createObjectURL(blob)
				: null,
	});
	return shared;
}
