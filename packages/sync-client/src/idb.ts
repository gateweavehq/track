import {
	ENTITY_NAMES,
	type Entities,
	type EntityName,
	mutationSchema,
	type Op,
	PROTOCOL_VERSION,
	type Snapshot,
} from "@gateweave/track-protocol";
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from "idb";
import { PendingFormatError, type Persistence, type StoredReplica } from "./persistence";
import type { PendingMutation } from "./store";

const DB_PREFIX = "track:";

/**
 * Bump when the stored layout changes. The database version also folds in the protocol version,
 * so cached rows never outlive the entity shapes they were written with. The pending store and
 * client id outlive both protocol and storage upgrades; the server validates stored edits on resend.
 */
const STORAGE_VERSION = 1;
export const DB_VERSION = PROTOCOL_VERSION * 1000 + STORAGE_VERSION;
/** Pending rows have { id, mutation, createdAt }, ordered by their auto-increment keys. */
const PENDING_FORMAT = 1;

function checkPendingFormat(format: unknown): void {
	// Format 1 is the only known format. Add an explicit migration case for an older known
	// format before accepting it; unknown and newer formats must keep the old DB intact.
	switch (format) {
		case undefined:
		case PENDING_FORMAT:
			return;
		default:
			throw new PendingFormatError(format);
	}
}

interface ReplicaSchema extends DBSchema {
	meta: { key: "clientId" | "version" | "pendingFormat"; value: string | number };
	team: { key: string; value: Entities["team"] };
	status: { key: string; value: Entities["status"] };
	issue: { key: string; value: Entities["issue"] };
	label: { key: string; value: Entities["label"] };
	project: { key: string; value: Entities["project"] };
	projectUpdate: { key: string; value: Entities["projectUpdate"] };
	cycle: { key: string; value: Entities["cycle"] };
	comment: { key: string; value: Entities["comment"] };
	activity: { key: string; value: Entities["activity"] };
	proposal: { key: string; value: Entities["proposal"] };
	relation: { key: string; value: Entities["relation"] };
	view: { key: string; value: Entities["view"] };
	template: { key: string; value: Entities["template"] };
	member: { key: string; value: Entities["member"] };
	subscription: { key: string; value: Entities["subscription"] };
	inbox: { key: string; value: Entities["inbox"] };
	pullRequest: { key: string; value: Entities["pullRequest"] };
	pending: { key: number; value: PendingMutation & { seq?: number }; indexes: { id: string } };
}

type Database = IDBPDatabase<ReplicaSchema>;

const STATE_STORES = ["meta", ...ENTITY_NAMES] as const;
const ALL_STORES = [...STATE_STORES, "pending"] as const;

export interface IdbPersistenceOptions {
	/**
	 * Another tab deleted this replica, as on signing out. The client is left with memory alone. If
	 * it leads, every tab opened after this reads an empty database and waits for it forever, so the
	 * page should let go of this client rather than carry on.
	 */
	onDeleted?: () => void;
	/**
	 * The database version to open, as a newer build's is. Defaults to this build's; a test passes
	 * a higher one to play the upgrade a person meets after a deploy.
	 */
	version?: number;
}

/**
 * Opens the IndexedDB replica stored under `key`. Use a key that is unique per user and
 * workspace, so that two accounts on one browser never read each other's data.
 */
export async function openIdbPersistence(
	key: string,
	options: IdbPersistenceOptions = {},
): Promise<Persistence> {
	let persistence: IdbPersistence | undefined;
	let upgradeError: unknown;
	const db = await openDB<ReplicaSchema>(DB_PREFIX + key, options.version ?? DB_VERSION, {
		upgrade(db, _oldVersion, _newVersion, tx) {
			// Read the format before changing any store. Aborting this transaction preserves the old DB.
			const meta = db.objectStoreNames.contains("meta") ? tx.objectStore("meta") : null;
			const check = meta ? meta.get("pendingFormat") : Promise.resolve(undefined);
			check
				.then((format) => {
					checkPendingFormat(format);
					const keepUnsent = db.objectStoreNames.contains("pending") && meta !== null;
					for (const name of [...db.objectStoreNames]) {
						if (keepUnsent && (name === "pending" || name === "meta")) continue;
						db.deleteObjectStore(name);
					}
					if (!keepUnsent) db.createObjectStore("meta");
					for (const entity of ENTITY_NAMES) db.createObjectStore(entity, { keyPath: "id" });
					if (keepUnsent) {
						void meta.delete("version").catch(() => {});
						void meta.put(PENDING_FORMAT, "pendingFormat").catch(() => {});
					} else {
						const pending = db.createObjectStore("pending", {
							keyPath: "seq",
							autoIncrement: true,
						});
						pending.createIndex("id", "id", { unique: true });
						void tx
							.objectStore("meta")
							.put(PENDING_FORMAT, "pendingFormat")
							.catch(() => {});
					}
				})
				.catch((error: unknown) => {
					upgradeError = error;
					void tx.done.catch(() => {});
					try {
						tx.abort();
					} catch {
						/* The transaction already failed. */
					}
				});
			void tx.done.catch(() => {});
		},
		// The client drains its queued writes before closing for an upgrade. A delete closes now.
		blocking(_current, blockedVersion) {
			if (blockedVersion === null) {
				persistence?.close();
				options.onDeleted?.();
			} else persistence?.taken();
		},
	}).catch((error: unknown) => {
		throw upgradeError ?? error;
	});
	persistence = new IdbPersistence(db);
	return persistence;
}

/**
 * Deletes the replica stored under `key`, for example once the user has lost access to its
 * workspace. Tabs that still have it open close their copy and hear of it through `onDeleted`.
 */
export async function deleteIdbReplica(key: string): Promise<void> {
	await deleteDB(DB_PREFIX + key);
}

/** Deletes every replica stored by this app in this browser, for example on sign-out. */
export async function deleteIdbReplicas(): Promise<void> {
	const databases = await indexedDB.databases();
	await Promise.all(
		databases
			.flatMap(({ name }) => (name?.startsWith(DB_PREFIX) ? [name] : []))
			.map((name) => deleteDB(name)),
	);
}

class IdbPersistence implements Persistence {
	readonly shared = true;
	#onTaken?: () => void;

	constructor(private readonly db: Database) {}
	onTaken(listener: () => void): void {
		this.#onTaken = listener;
	}
	taken(): void {
		if (this.#onTaken) this.#onTaken();
		else this.close();
	}

	async load(): Promise<StoredReplica> {
		const tx = this.db.transaction(ALL_STORES, "readwrite");
		const meta = tx.objectStore("meta");
		const format = await meta.get("pendingFormat");
		try {
			checkPendingFormat(format);
		} catch (error) {
			void tx.done.catch(() => {});
			tx.abort();
			throw error;
		}
		if (format === undefined) await meta.put(PENDING_FORMAT, "pendingFormat");
		let clientId = (await meta.get("clientId")) as string | undefined;
		if (!clientId) {
			clientId = crypto.randomUUID();
			await meta.put(clientId, "clientId");
		}
		const [
			version,
			teams,
			statuses,
			issues,
			labels,
			projects,
			projectUpdates,
			cycles,
			comments,
			activities,
			proposals,
			relations,
			views,
			templates,
			members,
			subscriptions,
			inbox,
			pullRequests,
			pending,
		] = await Promise.all([
			meta.get("version") as Promise<number | undefined>,
			tx.objectStore("team").getAll(),
			tx.objectStore("status").getAll(),
			tx.objectStore("issue").getAll(),
			tx.objectStore("label").getAll(),
			tx.objectStore("project").getAll(),
			tx.objectStore("projectUpdate").getAll(),
			tx.objectStore("cycle").getAll(),
			tx.objectStore("comment").getAll(),
			tx.objectStore("activity").getAll(),
			tx.objectStore("proposal").getAll(),
			tx.objectStore("relation").getAll(),
			tx.objectStore("view").getAll(),
			tx.objectStore("template").getAll(),
			tx.objectStore("member").getAll(),
			tx.objectStore("subscription").getAll(),
			tx.objectStore("inbox").getAll(),
			tx.objectStore("pullRequest").getAll(),
			tx.objectStore("pending").getAll(),
		]);
		await tx.done;
		return {
			clientId,
			snapshot:
				version === undefined
					? null
					: {
							version,
							teams,
							statuses,
							issues,
							labels,
							projects,
							projectUpdates,
							cycles,
							comments,
							activities,
							proposals,
							relations,
							views,
							templates,
							members,
							subscriptions,
							inbox,
							pullRequests,
						},
			...readPending(pending),
		};
	}

	async replace(snapshot: Snapshot): Promise<void> {
		const tx = this.db.transaction(STATE_STORES, "readwrite", { durability: "relaxed" });
		const rows = {
			team: snapshot.teams,
			status: snapshot.statuses,
			issue: snapshot.issues,
			label: snapshot.labels,
			project: snapshot.projects,
			projectUpdate: snapshot.projectUpdates,
			cycle: snapshot.cycles,
			comment: snapshot.comments,
			activity: snapshot.activities,
			proposal: snapshot.proposals,
			relation: snapshot.relations,
			view: snapshot.views,
			template: snapshot.templates,
			member: snapshot.members,
			subscription: snapshot.subscriptions,
			inbox: snapshot.inbox,
			pullRequest: snapshot.pullRequests,
		};
		await Promise.all([
			...ENTITY_NAMES.map(async (entity) => {
				const store = rowStore(tx, entity);
				await store.clear();
				await Promise.all(rows[entity].map((row) => store.put(row)));
			}),
			tx.objectStore("meta").put(snapshot.version, "version"),
			tx.done,
		]);
	}

	async applyOps(ops: readonly Op[], version: number): Promise<void> {
		const tx = this.db.transaction(STATE_STORES, "readwrite", { durability: "relaxed" });
		await Promise.all([
			...ops.map((op) =>
				op.op === "put"
					? rowStore(tx, op.entity).put(op.data)
					: rowStore(tx, op.entity).delete(op.id),
			),
			tx.objectStore("meta").put(version, "version"),
			tx.done,
		]);
	}

	async addPending(...mutations: PendingMutation[]): Promise<void> {
		// Unsent mutations exist nowhere else, so this write asks for full durability. A batch goes
		// in one transaction, so it is stored whole or not at all.
		const tx = this.db.transaction("pending", "readwrite", { durability: "strict" });
		await Promise.all([...mutations.map((mutation) => tx.store.add(mutation)), tx.done]);
	}

	async removePending(id: string | number): Promise<boolean> {
		const tx = this.db.transaction("pending", "readwrite");
		const seq = typeof id === "number" ? id : await tx.store.index("id").getKey(id);
		const exists = seq !== undefined && (await tx.store.getKey(seq)) !== undefined;
		if (seq !== undefined) await tx.store.delete(seq);
		await tx.done;
		return exists;
	}

	close(): void {
		this.db.close();
	}
}

function readPending(rows: readonly unknown[]): Pick<StoredReplica, "pending" | "unreadable"> {
	const pending: PendingMutation[] = [];
	const unreadable: StoredReplica["unreadable"] = [];
	for (const row of rows) {
		const record = isRecord(row) ? row : {};
		const id = record.id;
		if (typeof id !== "string" || !id) {
			const fields = isRecord(record.mutation) ? record.mutation : {};
			unreadable.push({
				seq: typeof record.seq === "number" ? record.seq : undefined,
				name: typeof fields.name === "string" ? fields.name : "Stored change",
				args: isRecord(fields.args) ? fields.args : {},
			});
			continue;
		}
		const mutation = record.mutation;
		const parsed = mutationSchema.safeParse(mutation);
		if (
			parsed.success &&
			typeof record.createdAt === "number" &&
			Number.isFinite(record.createdAt)
		) {
			pending.push({
				id,
				mutation: mutation as PendingMutation["mutation"],
				createdAt: record.createdAt,
			});
		} else {
			const fields = isRecord(mutation) ? mutation : {};
			unreadable.push({
				id,
				name: typeof fields.name === "string" ? fields.name : "Stored change",
				args: isRecord(fields.args) ? fields.args : {},
			});
		}
	}
	return { pending, unreadable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The row store for an entity, typed loosely enough to take any entity's rows. */
function rowStore(tx: { objectStore(name: EntityName): unknown }, entity: EntityName) {
	return tx.objectStore(entity) as {
		put(row: Entities[EntityName]): Promise<unknown>;
		delete(id: string): Promise<void>;
		clear(): Promise<void>;
	};
}
