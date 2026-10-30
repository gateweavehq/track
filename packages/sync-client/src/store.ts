import type { Entities, EntityName, Mutation, Op, Snapshot } from "@gateweave/track-protocol";
import { applyOptimistic } from "./optimistic";

/** What the UI reads: the server's state with this device's unconfirmed mutations applied. */
export interface SyncState {
	/** Highest server version reflected in this state. */
	readonly version: number;
	readonly teams: ReadonlyMap<string, Entities["team"]>;
	readonly issues: ReadonlyMap<string, Entities["issue"]>;
	readonly labels: ReadonlyMap<string, Entities["label"]>;
	readonly projects: ReadonlyMap<string, Entities["project"]>;
	readonly comments: ReadonlyMap<string, Entities["comment"]>;
	readonly activities: ReadonlyMap<string, Entities["activity"]>;
	/** Agents' open proposals. */
	readonly proposals: ReadonlyMap<string, Entities["proposal"]>;
	readonly relations: ReadonlyMap<string, Entities["relation"]>;
	readonly members: ReadonlyMap<string, Entities["member"]>;
}

/** A mutation made on this device that the server has not confirmed yet. */
export interface PendingMutation {
	id: string;
	mutation: Mutation;
	/** Client time the mutation was made. Optimistic rows use it as their timestamp. */
	createdAt: number;
}

type Tables = { readonly [E in EntityName]: ReadonlyMap<string, Entities[E]> };

const EMPTY: Tables = {
	team: new Map(),
	issue: new Map(),
	label: new Map(),
	project: new Map(),
	comment: new Map(),
	activity: new Map(),
	proposal: new Map(),
	relation: new Map(),
	member: new Map(),
};

/**
 * Copy-on-write view over a set of tables. A table is copied on its first write, so tables that
 * are not touched keep their identity and memoized selectors over them stay valid.
 */
export class Draft {
	readonly #tables: { [E in EntityName]: ReadonlyMap<string, Entities[E]> };
	readonly #copied = new Set<EntityName>();

	constructor(base: Tables) {
		this.#tables = { ...base };
	}

	get<E extends EntityName>(entity: E, id: string): Entities[E] | undefined {
		return this.#tables[entity].get(id);
	}

	values<E extends EntityName>(entity: E): IterableIterator<Entities[E]> {
		return this.#tables[entity].values();
	}

	put<E extends EntityName>(entity: E, row: Entities[E]): void {
		this.#writable(entity).set(row.id, row);
	}

	delete(entity: EntityName, id: string): void {
		if (this.#tables[entity].has(id)) this.#writable(entity).delete(id);
	}

	finish(): Tables {
		return { ...this.#tables };
	}

	#writable<E extends EntityName>(entity: E): Map<string, Entities[E]> {
		if (!this.#copied.has(entity)) {
			this.#copied.add(entity);
			(this.#tables as Record<EntityName, unknown>)[entity] = new Map(this.#tables[entity]);
		}
		return this.#tables[entity] as Map<string, Entities[E]>;
	}
}

/**
 * The client's copy of a workspace. Holds the confirmed server state and the pending mutations,
 * and derives the visible state by replaying pending mutations on top of the confirmed state
 * whenever either changes. Server results therefore always win, and a rejected mutation simply
 * stops being replayed.
 */
export class Replica {
	#confirmed: Tables = EMPTY;
	#version = 0;
	#hasData = false;
	#pending: PendingMutation[] = [];
	#state: SyncState = toState(EMPTY, 0);
	readonly #listeners = new Set<() => void>();

	constructor(private readonly userId: string) {}

	get version(): number {
		return this.#version;
	}

	/** True once the replica holds server data, from storage or from a snapshot. */
	get hasData(): boolean {
		return this.#hasData;
	}

	get pending(): readonly PendingMutation[] {
		return this.#pending;
	}

	getState = (): SyncState => this.#state;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	/**
	 * Replaces the confirmed state with a snapshot. With `onlyIfNewer`, an older or equal snapshot
	 * is ignored, which is what callers loading from shared storage want.
	 */
	reset(snapshot: Snapshot, { onlyIfNewer = false } = {}): void {
		if (onlyIfNewer && this.#hasData && snapshot.version <= this.#version) return;
		this.#confirmed = {
			team: new Map(snapshot.teams.map((row) => [row.id, row])),
			issue: new Map(snapshot.issues.map((row) => [row.id, row])),
			label: new Map(snapshot.labels.map((row) => [row.id, row])),
			project: new Map(snapshot.projects.map((row) => [row.id, row])),
			comment: new Map(snapshot.comments.map((row) => [row.id, row])),
			activity: new Map(snapshot.activities.map((row) => [row.id, row])),
			proposal: new Map(snapshot.proposals.map((row) => [row.id, row])),
			relation: new Map(snapshot.relations.map((row) => [row.id, row])),
			member: new Map(snapshot.members.map((row) => [row.id, row])),
		};
		this.#version = snapshot.version;
		this.#hasData = true;
		this.#rebuild();
	}

	/**
	 * Applies server ops in version order. Ops at or below the current version are skipped, so
	 * replaying is harmless. Returns false, without applying anything, if the ops do not continue
	 * from the current version.
	 */
	applyOps(ops: readonly Op[]): boolean {
		const fresh = ops.filter((op) => op.version > this.#version);
		if (fresh.length === 0) return true;
		if (fresh.some((op, index) => op.version !== this.#version + 1 + index)) return false;

		const draft = new Draft(this.#confirmed);
		for (const op of fresh) {
			if (op.op === "put") draft.put(op.entity, op.data as Entities[typeof op.entity]);
			else draft.delete(op.entity, op.id);
		}
		this.#confirmed = draft.finish();
		this.#version += fresh.length;
		this.#rebuild();
		return true;
	}

	/** Queues mutations in order, skipping ids that are already queued. */
	addPending(...mutations: PendingMutation[]): void {
		const known = new Set(this.#pending.map((p) => p.id));
		const added = mutations.filter((p) => !known.has(p.id));
		if (added.length === 0) return;
		this.#pending = [...this.#pending, ...added];
		this.#rebuild();
	}

	removePending(id: string): PendingMutation | undefined {
		const removed = this.#pending.find((p) => p.id === id);
		if (!removed) return undefined;
		this.#pending = this.#pending.filter((p) => p !== removed);
		this.#rebuild();
		return removed;
	}

	/** The confirmed state, for writing to storage. */
	snapshot(): Snapshot {
		return {
			version: this.#version,
			teams: [...this.#confirmed.team.values()],
			issues: [...this.#confirmed.issue.values()],
			labels: [...this.#confirmed.label.values()],
			projects: [...this.#confirmed.project.values()],
			comments: [...this.#confirmed.comment.values()],
			activities: [...this.#confirmed.activity.values()],
			proposals: [...this.#confirmed.proposal.values()],
			relations: [...this.#confirmed.relation.values()],
			members: [...this.#confirmed.member.values()],
		};
	}

	#rebuild(): void {
		let tables = this.#confirmed;
		if (this.#pending.length > 0) {
			const draft = new Draft(tables);
			for (const pending of this.#pending) applyOptimistic(draft, pending, this.userId);
			tables = draft.finish();
		}
		this.#state = toState(tables, this.#version);
		for (const listener of [...this.#listeners]) listener();
	}
}

function toState(tables: Tables, version: number): SyncState {
	return {
		version,
		teams: tables.team,
		issues: tables.issue,
		labels: tables.label,
		projects: tables.project,
		comments: tables.comment,
		activities: tables.activity,
		proposals: tables.proposal,
		relations: tables.relation,
		members: tables.member,
	};
}
