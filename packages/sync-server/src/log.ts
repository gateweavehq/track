import type { Entities, EntityName, Op, Proposal } from "@gateweave/track-protocol";
import { and, asc, eq, gt, lt, lte, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Db } from "./state";
import type { ChangeEvent } from "./webhooks";

const FLOOR_KEY = "oplog_floor";

export interface WriteResult {
	/** Workspace version after the write. Unchanged if nothing was written. */
	version: number;
	ops: Op[];
	/** Webhook deliveries the write queued, which the alarm sends. */
	queued?: number;
	/** Whether the alarm should run now, to plan around what the write changed. */
	wake?: boolean;
	/** What an agent's write proposed instead of making, open proposals included as they stand. */
	proposed?: Proposal[];
}

/**
 * Collects the ops produced by one logical write. Each op gets the next workspace version, so
 * versions are gapless and totally ordered. Must be used inside a storage transaction.
 */
export class ChangeSet {
	readonly ops: Op[] = [];
	/** What the write did, in the terms webhooks report. Handlers add to it. */
	readonly events: ChangeEvent[] = [];
	/** What an agent's write proposed instead of making, for the agent to be told. */
	readonly proposed: Proposal[] = [];
	#next: number;

	constructor(
		private readonly db: Db,
		private readonly actorId: string | null,
		readonly now: number,
	) {
		this.#next = currentVersion(db) + 1;
	}

	/** The version the next op will get. Rows that carry a version should be stamped with this. */
	get nextVersion(): number {
		return this.#next;
	}

	put<E extends EntityName>(entity: E, data: Entities[E]): void {
		this.#append({ version: this.#next, entity, id: data.id, op: "put", data } as Op);
	}

	delete(entity: EntityName, id: string): void {
		this.#append({ version: this.#next, entity, id, op: "delete" });
	}

	result(): WriteResult {
		return { version: this.#next - 1, ops: this.ops };
	}

	#append(op: Op): void {
		this.db
			.insert(schema.oplog)
			.values({
				version: op.version,
				entity: op.entity,
				entityId: op.id,
				op: op.op,
				data: op.op === "put" ? op.data : null,
				actorId: this.actorId,
				at: this.now,
			})
			.run();
		this.ops.push(op);
		this.#next += 1;
	}
}

export function currentVersion(db: Db): number {
	const row = db
		.select({ version: sql<number | null>`max(${schema.oplog.version})` })
		.from(schema.oplog)
		.get();
	return Math.max(row?.version ?? 0, oplogFloor(db));
}

/** Ops at or below this version have been compacted away. Clients behind it must re-snapshot. */
export function oplogFloor(db: Db): number {
	const row = db.select().from(schema.meta).where(eq(schema.meta.key, FLOOR_KEY)).get();
	return row ? Number(row.value) : 0;
}

export function opsSince(db: Db, since: number, limit: number): Op[] {
	return db
		.select()
		.from(schema.oplog)
		.where(gt(schema.oplog.version, since))
		.orderBy(asc(schema.oplog.version))
		.limit(limit)
		.all()
		.map(
			(row) =>
				({
					version: row.version,
					entity: row.entity,
					id: row.entityId,
					op: row.op,
					...(row.op === "put" ? { data: row.data } : {}),
				}) as Op,
		);
}

export interface RetentionPolicy {
	/** Always keep at least this many recent ops. */
	minOps: number;
	/** Never drop ops younger than this. */
	minAgeMs: number;
}

/** Drops ops that are both old and far behind the head, and forgets matching mutation ids. */
export function compact(db: Db, now: number, policy: RetentionPolicy): void {
	const cutoffTime = now - policy.minAgeMs;
	const head = currentVersion(db);
	const row = db
		.select({ version: sql<number | null>`max(${schema.oplog.version})` })
		.from(schema.oplog)
		.where(and(lte(schema.oplog.version, head - policy.minOps), lt(schema.oplog.at, cutoffTime)))
		.get();

	const floor = row?.version;
	if (floor) {
		db.delete(schema.oplog).where(lte(schema.oplog.version, floor)).run();
		db.insert(schema.meta)
			.values({ key: FLOOR_KEY, value: String(floor) })
			.onConflictDoUpdate({ target: schema.meta.key, set: { value: String(floor) } })
			.run();
	}
	db.delete(schema.appliedMutations).where(lt(schema.appliedMutations.at, cutoffTime)).run();
}
