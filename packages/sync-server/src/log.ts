import {
	type Entities,
	type EntityName,
	type Issue,
	isPrivateEntity,
	type Op,
	type PrivateEntityName,
	type Proposal,
	toSyncedIssue,
} from "@gateweave/track-protocol";
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Db } from "./state";
import type { ChangeEvent } from "./webhooks";

const FLOOR_KEY = "oplog_floor";

export interface WriteResult {
	/** Workspace version after the write. Unchanged if nothing was written. */
	version: number;
	ops: Op[];
	/** The member each private op is for, by version. Every other op is for everyone. */
	audience?: ReadonlyMap<number, string>;
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
	readonly #audience = new Map<number, string>();
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

	/**
	 * Records a row. A private entity's row goes to its member alone. An archived issue goes out
	 * slim, and a row that belongs only to archived issues goes out as a delete: replicas keep
	 * neither their details nor their comments, history, proposals and pull requests.
	 */
	put<E extends EntityName>(entity: E, data: Entities[E]): void {
		if (onlyArchived(this.db, entity, data)) {
			this.delete(entity as Exclude<EntityName, PrivateEntityName>, data.id);
			return;
		}
		const audience = isPrivateEntity(entity)
			? (data as Entities[PrivateEntityName]).memberId
			: null;
		// Every caller passes the whole row; whether replicas see it whole is decided here.
		const row = entity === "issue" ? toSyncedIssue(data as Issue) : data;
		this.#append(
			{ version: this.#next, entity, id: data.id, op: "put", data: row } as Op,
			audience,
		);
	}

	delete(entity: Exclude<EntityName, PrivateEntityName>, id: string): void {
		this.#append({ version: this.#next, entity, id, op: "delete" }, null);
	}

	/** Records that a member's private row is gone, for that member alone. */
	deletePrivate(entity: PrivateEntityName, id: string, memberId: string): void {
		this.#append({ version: this.#next, entity, id, op: "delete" }, memberId);
	}

	result(): WriteResult {
		return {
			version: this.#next - 1,
			ops: this.ops,
			...(this.#audience.size > 0 && { audience: this.#audience }),
		};
	}

	#append(op: Op, audience: string | null): void {
		this.db
			.insert(schema.oplog)
			.values({
				version: op.version,
				entity: op.entity,
				entityId: op.id,
				op: op.op,
				data: op.op === "put" ? op.data : null,
				actorId: this.actorId,
				audience,
				at: this.now,
			})
			.run();
		this.ops.push(op);
		if (audience !== null) this.#audience.set(op.version, audience);
		this.#next += 1;
	}
}

/**
 * Whether the row is a comment, history entry, proposal or pull request of archived issues only,
 * which replicas do not hold.
 */
export function onlyArchived(db: Db, entity: EntityName, data: Entities[EntityName]): boolean {
	let issueIds: string[];
	if (entity === "comment" || entity === "activity" || entity === "proposal") {
		issueIds = [(data as Entities["comment" | "activity" | "proposal"]).issueId];
	} else if (entity === "pullRequest") {
		issueIds = (data as Entities["pullRequest"]).issueIds;
		if (issueIds.length === 0) return false;
	} else {
		return false;
	}
	let found = false;
	// A Durable Object binds at most 100 values in a statement, and a pull request can name more.
	for (let at = 0; at < issueIds.length; at += 50) {
		const issues = db
			.select({ archivedAt: schema.issues.archivedAt })
			.from(schema.issues)
			.where(inArray(schema.issues.id, issueIds.slice(at, at + 50)))
			.all();
		if (issues.some((issue) => issue.archivedAt === null)) return false;
		found ||= issues.length > 0;
	}
	return found;
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

/** The ops after `since` that `memberId` may see: everyone's, and their own private ones. */
export function opsSince(db: Db, since: number, limit: number, memberId: string): Op[] {
	return db
		.select()
		.from(schema.oplog)
		.where(
			and(
				gt(schema.oplog.version, since),
				or(isNull(schema.oplog.audience), eq(schema.oplog.audience, memberId)),
			),
		)
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
