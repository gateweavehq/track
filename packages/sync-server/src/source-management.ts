import {
	type AuditAction,
	EVENT_CLOCK_SKEW_MS,
	LIVE_RUNS,
	LIVE_SIGNALS,
	RESTORE_ISSUE_MISSING,
	SOURCES_PER_WORKSPACE,
	type Source,
	type SourceAction,
	type SourceRestore,
	sourceAction,
	sourceRestoreSchema,
	sourceSettingsSchema,
	UNFINISHED_RUN_STATES,
	WORKSPACE_RESTORE_SIGNAL_BYTES,
} from "@gateweave/track-protocol";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "./audit";
import { auditEvents, issues, meta, signals, sources, teams } from "./db/schema";
import { ChangeSet } from "./log";
import { MutationRejected } from "./rejected";
import { activeMember, type Db, toSignal, toSource } from "./state";

export class SourceLimit extends MutationRejected {
	constructor() {
		super("invalid", `A workspace can have ${SOURCES_PER_WORKSPACE} sources`);
	}
}

const id = z.string().min(1).max(64);
const revokePrefix = "source-revoke:";
// A revoked key's id stays until its source is removed. The gateway's D1 lookup can come before
// a revocation and its call here after, as when the sender holds the body back, so this decides.
const revokedPrefix = "source-revoked:";

/** Whether a key was revoked, or is being revoked: from then on it admits no event. */
export function keyRevoked(db: Db, sourceId: string, keyId: string): boolean {
	const row = db
		.select()
		.from(meta)
		.where(eq(meta.key, revokedPrefix + keyId))
		.get();
	return row?.value === sourceId;
}

// Key ids carry the restore that issued them across the D1 lookup and both halves of a rotation.
const restoreGeneration = "source-restore-generation:";
export function restoreGenerationOf(db: Db, sourceId: string) {
	return sourceId.startsWith("import-")
		? db
				.select()
				.from(meta)
				.where(eq(meta.key, restoreGeneration + sourceId))
				.get()?.value
		: undefined;
}

export function matchesRestore(db: Db, sourceId: string, keyId?: string) {
	const prefix = restoreGenerationOf(db, sourceId);
	return !prefix || keyId?.startsWith(prefix) === true;
}

const internalAction = z.union([
	z.strictObject({ kind: z.literal("keyCreated"), id, keyId: id.optional() }),
	z.strictObject({
		kind: z.enum(["prepareRemoval", "checkKey"]),
		id,
	}),
	z.strictObject({ kind: z.literal("finishRemoval"), id, generation: id.optional() }),
]);
const keyRevocation = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("prepareRevoke"), id, keyId: id, listed: z.boolean() }),
	z.strictObject({ kind: z.literal("keyRevoked"), id, keyId: id }),
]);
export type KeyRevocation = z.infer<typeof keyRevocation>;

export function revokeSourceKey(db: Db, memberId: string, command: KeyRevocation, now: number) {
	const action = keyRevocation.parse(command);
	const { id, keyId } = action;
	const pending = revokePrefix + keyId;
	const completed = db
		.select({ id: auditEvents.id })
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.action, "source.keyRevoked"),
				eq(auditEvents.targetId, id),
				sql`json_extract(${auditEvents.detail}, '$.keyId') = ${keyId}`,
			),
		)
		.limit(1)
		.get();
	if (completed) return;
	const proof = db.select().from(meta).where(eq(meta.key, pending)).get();
	if (proof && proof.value !== id) throw new MutationRejected("not_found", "Key not found");
	if (action.kind === "prepareRevoke") {
		if (proof) return;
		if (!action.listed) throw new MutationRejected("not_found", "Key not found");
		db.insert(meta).values({ key: pending, value: id }).run();
		db.insert(meta)
			.values({ key: revokedPrefix + keyId, value: id })
			.onConflictDoNothing()
			.run();
		return;
	}
	if (!proof) throw new MutationRejected("not_found", "Key not found");
	const source = db.select({ name: sources.name }).from(sources).where(eq(sources.id, id)).get();
	db.delete(meta).where(eq(meta.key, pending)).run();
	recordAudit(
		db,
		{
			actorId: memberId,
			action: "source.keyRevoked",
			target: { type: "source", id, label: source?.name ?? null },
			detail: { keyId },
		},
		now,
	);
}

// A connection records the id before it creates the source. Settings accepts only sourceAction.
const gatewayCreate = z.strictObject({
	kind: z.literal("create"),
	id: z.uuid(),
	notAfter: z.number().int(),
	input: sourceSettingsSchema,
});

export type SourceAdminAction =
	| z.input<typeof gatewayCreate>
	| Extract<SourceAction, { kind: "create" | "update" | "assign" | "pause" }>
	| z.infer<typeof internalAction>;

function requireTeam(db: Db, teamId: string) {
	if (!db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get())
		throw new MutationRejected("not_found", "Team not found");
}

function requireSourceCapacity(db: Db) {
	if ((db.select({ n: count() }).from(sources).get()?.n ?? 0) >= SOURCES_PER_WORKSPACE)
		throw new SourceLimit();
}

export function manageSource(db: Db, memberId: string, command: SourceAdminAction, now: number) {
	const parsed = z.union([gatewayCreate, sourceAction, internalAction]).safeParse(command);
	if (!parsed.success) throw new MutationRejected("invalid", "Invalid source settings");
	const action = parsed.data;
	const changes = new ChangeSet(db, memberId, now);
	function audit(source: Source, action: AuditAction) {
		recordAudit(
			db,
			{
				actorId: memberId,
				action,
				target: { type: "source", id: source.id, label: source.name },
			},
			now,
		);
	}

	if (action.kind === "create") {
		if ("notAfter" in action && now > action.notAfter)
			throw new MutationRejected("invalid", "Source approval expired");
		requireTeam(db, action.input.teamId);
		requireSourceCapacity(db);
		const sourceId = "id" in action ? action.id : crypto.randomUUID();
		if (db.select({ id: sources.id }).from(sources).where(eq(sources.id, sourceId)).get())
			throw new MutationRejected("invalid", "Source id already exists");
		const source = toSource(
			db
				.insert(sources)
				.values({
					...action.input,
					id: sourceId,
					paused: false,
					assigneeId: null,
					lastHeardAt: null,
				})
				.returning()
				.get(),
		);
		changes.put("source", source);
		audit(source, "source.created");
		return { ...changes.result(), source };
	}
	liveConnectSeal(db, changes, action.id);
	const row = db.select().from(sources).where(eq(sources.id, action.id)).get();
	if (
		!row ||
		(row.removing && action.kind !== "prepareRemoval" && action.kind !== "finishRemoval")
	) {
		throw new MutationRejected("not_found", "Source not found");
	}
	let source = toSource(row);
	switch (action.kind) {
		case "pause":
		case "assign":
		case "update": {
			if (action.kind === "update") {
				if (!Object.keys(action.input).length) break;
				if (action.input.teamId !== undefined) requireTeam(db, action.input.teamId);
			}
			if (
				action.kind === "assign" &&
				action.assigneeId !== null &&
				activeMember(db, action.assigneeId)?.role !== "agent"
			) {
				throw new MutationRejected("invalid", "Choose an agent in this workspace");
			}
			const patch =
				action.kind === "update"
					? action.input
					: action.kind === "pause"
						? { paused: action.paused }
						: { assigneeId: action.assigneeId };
			source = toSource(
				db.update(sources).set(patch).where(eq(sources.id, row.id)).returning().get(),
			);
			changes.put("source", source);
			audit(source, source.paused && !row.paused ? "source.paused" : "source.updated");
			break;
		}
		case "prepareRemoval":
			// Seal first so even a key made during removal cannot write before D1 revocation finishes.
			db.delete(meta)
				.where(eq(meta.key, connectionSeal + row.id))
				.run();
			if (!row.removing) {
				source = toSource(
					db
						.update(sources)
						.set({ removing: true, paused: true })
						.where(eq(sources.id, row.id))
						.returning()
						.get(),
				);
				if (!row.paused) {
					changes.put("source", source);
					audit(source, "source.paused");
				}
			}
			return {
				...changes.result(),
				source: { ...source, generation: restoreGenerationOf(db, row.id) },
			};
		case "finishRemoval":
			if (restoreGenerationOf(db, row.id) !== action.generation)
				throw new MutationRejected("not_found", "Source not found");
			if (!row.removing) throw new MutationRejected("invalid", "Revoke the source's keys first");
			deleteSource(db, changes, source.id);
			audit(source, "source.deleted");
			break;
		case "checkKey": {
			const prefix = restoreGenerationOf(db, row.id);
			if (prefix)
				return {
					...changes.result(),
					source: {
						...source,
						generation: prefix,
						keyId: prefix + crypto.randomUUID().replaceAll("-", ""),
					},
				};
			break;
		}
		case "keyCreated":
			if (!matchesRestore(db, row.id, action.keyId))
				throw new MutationRejected("not_found", "Source not found");
			audit(source, "source.keyCreated");
			break;
		default:
			throw new MutationRejected("invalid", "This action needs the settings gateway");
	}
	return { ...changes.result(), source };
}

/** The gateway has derived the destination ids. Check every row against this workspace. */
export function restoreSource(db: Db, memberId: string, command: SourceRestore, now: number) {
	const parsed = sourceRestoreSchema.safeParse(command);
	if (!parsed.success) throw new MutationRejected("invalid", "Invalid source or signal");
	const { source, signals: rows, exportedAt } = parsed.data;
	// Every event a sender dated before the export, even by a clock running ahead, stays older. A
	// future export time from a crafted file counts as now.
	const senderFloor = Math.min(Date.parse(exportedAt), now) + EVENT_CLOCK_SKEW_MS;
	const importedId = /^import-[a-f0-9]{32}$/;
	if (!importedId.test(source.id))
		throw new MutationRejected("invalid", "Invalid restored source id");
	const changes = new ChangeSet(db, memberId, now);
	const counts = {
		restored: 0,
		present: 0,
		bound: 0,
		dropped: 0,
		otherTeam: 0,
		alreadyLinked: 0,
		overLimit: 0,
	};
	if (db.select({ id: sources.id }).from(sources).where(eq(sources.id, source.id)).get()) {
		counts.present++;
		return { ...changes.result(), counts };
	}
	requireTeam(db, source.teamId);
	requireSourceCapacity(db);
	const assigneeId =
		source.assigneeId && activeMember(db, source.assigneeId)?.role === "agent"
			? source.assigneeId
			: null;
	const restored = db
		.insert(sources)
		.values({ ...source, assigneeId, paused: true })
		.returning()
		.get();
	db.insert(meta)
		.values({ key: restoreGeneration + source.id, value: crypto.randomUUID().replaceAll("-", "") })
		.run();
	changes.put("source", toSource(restored));
	const keys = new Set<string>();
	const keyOf = (signal: { kind: string; key: string }) => `${signal.kind}\u0000${signal.key}`;
	// Count only replica fields. SQLite casts integers to their decimal text for this measure.
	const fields = [
		signals.id,
		signals.sourceId,
		signals.kind,
		signals.key,
		signals.type,
		signals.subject,
		signals.severity,
		signals.state,
		signals.url,
		signals.issueId,
		signals.reopens,
		signals.firstAt,
		signals.changedAt,
		signals.progress,
		signals.startedAt,
		signals.endedAt,
		signals.executor,
		signals.agentName,
		signals.waitReason,
		signals.waitDetail,
		signals.lastContactAt,
	];
	const fieldBytes = sql.join(
		fields.map((col) => sql`coalesce(length(cast(${col} as blob)), 0)`),
		sql` + `,
	);
	let bytes =
		db
			.select({ total: sql<number>`coalesce(sum(${fieldBytes}), 0)` })
			.from(signals)
			.get()?.total ?? 0;
	const encoder = new TextEncoder();
	let live = 0;
	let unfinished = 0;
	for (const signal of rows) {
		if (
			signal.sourceId !== source.id ||
			keys.has(keyOf(signal)) ||
			(signal.issueId !== null && !importedId.test(signal.issueId)) ||
			(signal.url && !source.linkOrigins.includes(new URL(signal.url).origin))
		)
			throw new MutationRejected("invalid", "Invalid signal for this source");
		keys.add(keyOf(signal));
		const issue =
			signal.issueId &&
			db
				.select({ id: issues.id, teamId: issues.teamId, deletedAt: issues.deletedAt })
				.from(issues)
				.where(eq(issues.id, signal.issueId))
				.get();
		// The importer sends signals only for issues it made or found. One with no row was refused or
		// is not saved yet, so refuse the whole source: a repeat import makes the issue and restores.
		if (signal.issueId && !issue) throw new MutationRejected("invalid", RESTORE_ISSUE_MISSING);
		if (!issue || issue.deletedAt !== null || issue.teamId !== source.teamId) {
			counts.dropped++;
			if (issue && issue.deletedAt === null) counts.otherTeam++;
			continue;
		}
		// Alerts share an issue one at a time; a run rides beside them, and runs ride together.
		if (
			signal.kind === "alert" &&
			db
				.select({ id: signals.id })
				.from(signals)
				.where(and(eq(signals.issueId, issue.id), eq(signals.kind, "alert")))
				.limit(1)
				.get()
		) {
			counts.dropped++;
			counts.alreadyLinked++;
			continue;
		}
		const replica = {
			...signal,
			id: crypto.randomUUID(),
			// A clock that stepped back can leave a genuine change before its first report.
			firstAt: Math.min(signal.firstAt, signal.changedAt, now),
			changedAt: Math.min(signal.changedAt, now),
		};
		const incoming = Object.values(replica).reduce<number>(
			(n, value) => n + (value === null ? 0 : encoder.encode(String(value)).length),
			0,
		);
		if (bytes + incoming > WORKSPACE_RESTORE_SIGNAL_BYTES) {
			counts.overLimit++;
			counts.dropped++;
			continue;
		}
		bytes += incoming;
		if (signal.state === "open" && ++live > LIVE_SIGNALS)
			throw new MutationRejected("invalid", "Too many open signals for this source");
		if (
			signal.kind === "run" &&
			(UNFINISHED_RUN_STATES as readonly string[]).includes(signal.state) &&
			++unfinished > LIVE_RUNS
		)
			throw new MutationRejected("invalid", "Too many unfinished runs for this source");
		const row = db
			.insert(signals)
			.values({
				...replica,
				// The file keeps receipt times, not the sender's, so sender order restarts after the
				// export: an older event, even replayed with the new key, gets the current state.
				lastSentAt: senderFloor,
				// The replica omits the clear time. Using the last change keeps inactive signals at least as long.
				clearedAt: signal.state === "open" ? null : Math.min(signal.changedAt, now),
			})
			.returning()
			.get();
		changes.put("signal", toSignal(row));
		counts.bound++;
	}
	counts.restored++;
	recordAudit(
		db,
		{
			actorId: memberId,
			action: "source.created",
			target: { type: "source", id: source.id, label: source.name },
		},
		now,
	);
	return { ...changes.result(), counts, wake: true };
}

const connectionSeal = "source-connect-seal:";
type ConnectSeal = { holder: string; expiresAt: number; paused: boolean };

function clearSeal(db: Db, changes: ChangeSet, sourceId: string, paused: boolean) {
	const source = db
		.update(sources)
		.set({ removing: false, paused })
		.where(eq(sources.id, sourceId))
		.returning()
		.get();
	db.delete(meta)
		.where(eq(meta.key, connectionSeal + sourceId))
		.run();
	if (!paused) changes.put("source", toSource(source));
}

export function liveConnectSeal(db: Db, changes: ChangeSet, sourceId: string) {
	const value = db
		.select()
		.from(meta)
		.where(eq(meta.key, connectionSeal + sourceId))
		.get()?.value;
	if (!value) return;
	// Old key-only markers have no lease. Restore the setting they recorded.
	if (value.startsWith("{")) {
		const seal: ConnectSeal = JSON.parse(value);
		if (changes.now < seal.expiresAt) return seal;
		clearSeal(db, changes, sourceId, seal.paused);
	} else clearSeal(db, changes, sourceId, !value.endsWith(":active"));
}

export function expireConnectSeals(db: Db, now: number) {
	const changes = new ChangeSet(db, null, now);
	for (const { key } of db
		.select({ key: meta.key })
		.from(meta)
		.where(sql`${meta.key} GLOB ${connectionSeal + "*"}`)
		.all())
		liveConnectSeal(db, changes, key.slice(connectionSeal.length));
	return changes.result();
}

export function releaseConnectedSource(db: Db, sourceId: string, holder: string, now: number) {
	const changes = new ChangeSet(db, null, now);
	const seal = liveConnectSeal(db, changes, sourceId);
	if (seal && seal.holder === holder) clearSeal(db, changes, sourceId, seal.paused);
	return changes.result();
}

function deleteSource(db: Db, changes: ChangeSet, sourceId: string) {
	for (const removed of db
		.delete(signals)
		.where(eq(signals.sourceId, sourceId))
		.returning({ id: signals.id })
		.all()) {
		changes.delete("signal", removed.id);
	}
	for (const prefix of [revokePrefix, revokedPrefix])
		db.delete(meta)
			.where(and(sql`${meta.key} GLOB ${prefix + "*"}`, eq(meta.value, sourceId)))
			.run();
	db.delete(meta)
		.where(eq(meta.key, restoreGeneration + sourceId))
		.run();
	db.delete(sources).where(eq(sources.id, sourceId)).run();
	changes.delete("source", sourceId);
	db.delete(meta)
		.where(eq(meta.key, connectionSeal + sourceId))
		.run();
}

// The gateway joins the approval key id and its nonce with a colon. Older holders name just the key.
function approvalKey(holder: string) {
	return holder.split(":", 1)[0] ?? holder;
}

export function removeConnectedSource(db: Db, sourceId: string, holder: string, now: number) {
	const changes = new ChangeSet(db, null, now);
	const result = (status: "sealed" | "heard" | "gone" | "kept" | "busy") => ({
		...changes.result(),
		status,
	});
	const seal = liveConnectSeal(db, changes, sourceId);
	const row = db.select().from(sources).where(eq(sources.id, sourceId)).get();
	if (!row) return result("gone");
	if (seal && seal.holder !== holder) return result("busy");
	if (keyRevoked(db, sourceId, approvalKey(holder))) {
		if (seal) clearSeal(db, changes, sourceId, seal.paused);
		return result("kept");
	}
	if (row.removing && !seal) return result("kept");
	// A 400 or 429 never counts as an accepted event, but a refusal can file a notice. A clear
	// for an unknown key changes nothing: during take-back nobody has the key, and during undo
	// its holder is the one asking. Check and seal in the same transaction as event admission.
	if (
		row.lastHeardAt !== null ||
		row.lastRefusedAt !== null ||
		row.usage.length ||
		db.select({ id: signals.id }).from(signals).where(eq(signals.sourceId, sourceId)).limit(1).get()
	)
		return result("heard");
	if (row.removing) return result("sealed");
	db.insert(meta)
		.values({
			key: connectionSeal + sourceId,
			value: JSON.stringify({
				holder,
				expiresAt: now + 120_000,
				paused: row.paused,
			} satisfies ConnectSeal),
		})
		.run();
	db.update(sources).set({ paused: true, removing: true }).where(eq(sources.id, sourceId)).run();
	if (!row.paused) changes.put("source", { ...toSource(row), paused: true });
	return result("sealed");
}

export function finishConnectedSourceRemoval(
	db: Db,
	sourceId: string,
	holder: string,
	reason: string,
	now: number,
) {
	const changes = new ChangeSet(db, null, now);
	const seal = liveConnectSeal(db, changes, sourceId);
	const row = db.select().from(sources).where(eq(sources.id, sourceId)).get();
	if (!row?.removing || !seal || seal.holder !== holder)
		return { ...changes.result(), status: "notHeld" as const };
	if (keyRevoked(db, sourceId, approvalKey(holder))) {
		clearSeal(db, changes, sourceId, seal.paused);
		return { ...changes.result(), status: "revoked" as const };
	}
	deleteSource(db, changes, sourceId);
	recordAudit(
		db,
		{
			actorId: null,
			action: "source.takenBack",
			target: { type: "source", id: sourceId, label: row.name },
			detail: { reason },
		},
		now,
	);
	return { ...changes.result(), status: "removed" as const };
}
