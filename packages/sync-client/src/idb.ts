import {
	ENTITY_NAMES,
	type Entities,
	type EntityName,
	type Op,
	PROTOCOL_VERSION,
	type Snapshot,
} from "@gateweave/track-protocol";
import { type DBSchema, deleteDB, type IDBPDatabase, openDB } from "idb";
import type { Persistence, StoredReplica } from "./persistence";
import type { PendingMutation } from "./store";

const DB_PREFIX = "track:";

/**
 * Bump when the stored layout changes. The database version also folds in the protocol version,
 * so stored rows never outlive the entity shapes they were written with: on an upgrade the old
 * stores are dropped and the replica re-syncs from the server.
 */
const STORAGE_VERSION = 1;
const DB_VERSION = PROTOCOL_VERSION * 1000 + STORAGE_VERSION;

interface ReplicaSchema extends DBSchema {
	meta: { key: "clientId" | "version"; value: string | number };
	team: { key: string; value: Entities["team"] };
	issue: { key: string; value: Entities["issue"] };
	label: { key: string; value: Entities["label"] };
	project: { key: string; value: Entities["project"] };
	cycle: { key: string; value: Entities["cycle"] };
	comment: { key: string; value: Entities["comment"] };
	activity: { key: string; value: Entities["activity"] };
	proposal: { key: string; value: Entities["proposal"] };
	relation: { key: string; value: Entities["relation"] };
	view: { key: string; value: Entities["view"] };
	member: { key: string; value: Entities["member"] };
	pending: { key: number; value: PendingMutation & { seq?: number }; indexes: { id: string } };
}

type Database = IDBPDatabase<ReplicaSchema>;

const STATE_STORES = ["meta", ...ENTITY_NAMES] as const;
const ALL_STORES = [...STATE_STORES, "pending"] as const;

/**
 * Opens the IndexedDB replica stored under `key`. Use a key that is unique per user and
 * workspace, so that two accounts on one browser never read each other's data.
 */
export async function openIdbPersistence(key: string): Promise<Persistence> {
	let persistence: IdbPersistence | undefined;
	const db = await openDB<ReplicaSchema>(DB_PREFIX + key, DB_VERSION, {
		upgrade(db) {
			for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
			db.createObjectStore("meta");
			for (const entity of ENTITY_NAMES) db.createObjectStore(entity, { keyPath: "id" });
			db.createObjectStore("pending", { keyPath: "seq", autoIncrement: true }).createIndex(
				"id",
				"id",
				{ unique: true },
			);
		},
		// Another tab is upgrading or deleting the database. Step aside instead of blocking it;
		// writes from here on fail, and the client carries on from memory.
		blocking() {
			persistence?.close();
		},
	});
	persistence = new IdbPersistence(db);
	return persistence;
}

/**
 * Deletes the replica stored under `key`, for example once the user has lost access to its
 * workspace. Tabs that still have it open close their copy and carry on from memory.
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

	constructor(private readonly db: Database) {}

	async load(): Promise<StoredReplica> {
		const tx = this.db.transaction(ALL_STORES, "readwrite");
		const meta = tx.objectStore("meta");
		let clientId = (await meta.get("clientId")) as string | undefined;
		if (!clientId) {
			clientId = crypto.randomUUID();
			await meta.put(clientId, "clientId");
		}
		const [
			version,
			teams,
			issues,
			labels,
			projects,
			cycles,
			comments,
			activities,
			proposals,
			relations,
			views,
			members,
			pending,
		] = await Promise.all([
			meta.get("version") as Promise<number | undefined>,
			tx.objectStore("team").getAll(),
			tx.objectStore("issue").getAll(),
			tx.objectStore("label").getAll(),
			tx.objectStore("project").getAll(),
			tx.objectStore("cycle").getAll(),
			tx.objectStore("comment").getAll(),
			tx.objectStore("activity").getAll(),
			tx.objectStore("proposal").getAll(),
			tx.objectStore("relation").getAll(),
			tx.objectStore("view").getAll(),
			tx.objectStore("member").getAll(),
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
							issues,
							labels,
							projects,
							cycles,
							comments,
							activities,
							proposals,
							relations,
							views,
							members,
						},
			pending: pending.map(({ seq: _, ...mutation }) => mutation),
		};
	}

	async replace(snapshot: Snapshot): Promise<void> {
		const tx = this.db.transaction(STATE_STORES, "readwrite", { durability: "relaxed" });
		const rows = {
			team: snapshot.teams,
			issue: snapshot.issues,
			label: snapshot.labels,
			project: snapshot.projects,
			cycle: snapshot.cycles,
			comment: snapshot.comments,
			activity: snapshot.activities,
			proposal: snapshot.proposals,
			relation: snapshot.relations,
			view: snapshot.views,
			member: snapshot.members,
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

	async addPending(mutation: PendingMutation): Promise<void> {
		// Unsent mutations exist nowhere else, so this write asks for full durability.
		const tx = this.db.transaction("pending", "readwrite", { durability: "strict" });
		await Promise.all([tx.store.add(mutation), tx.done]);
	}

	async removePending(id: string): Promise<void> {
		const tx = this.db.transaction("pending", "readwrite");
		const seq = await tx.store.index("id").getKey(id);
		if (seq !== undefined) await tx.store.delete(seq);
		await tx.done;
	}

	close(): void {
		this.db.close();
	}
}

/** The row store for an entity, typed loosely enough to take any entity's rows. */
function rowStore(tx: { objectStore(name: EntityName): unknown }, entity: EntityName) {
	return tx.objectStore(entity) as {
		put(row: Entities[EntityName]): Promise<unknown>;
		delete(id: string): Promise<void>;
		clear(): Promise<void>;
	};
}
