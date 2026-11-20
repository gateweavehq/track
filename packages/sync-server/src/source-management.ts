import {
	type AuditAction,
	SOURCES_PER_WORKSPACE,
	type Source,
	type SourceAction,
	sourceAction,
	sourceSettingsSchema,
} from "@gateweave/track-protocol";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "./audit";
import { auditEvents, meta, signals, sources, teams } from "./db/schema";
import { ChangeSet } from "./log";
import { MutationRejected } from "./rejected";
import { activeMember, type Db, toSource } from "./state";

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
const internalAction = z.strictObject({
	kind: z.enum(["prepareRemoval", "finishRemoval", "checkKey", "keyCreated"]),
	id,
});
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
	function requireTeam(teamId: string) {
		if (!db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get()) {
			throw new MutationRejected("not_found", "Team not found");
		}
	}
	if (action.kind === "create") {
		if ("notAfter" in action && now > action.notAfter)
			throw new MutationRejected("invalid", "Source approval expired");
		requireTeam(action.input.teamId);
		const found = db.select({ n: count() }).from(sources).get();
		if ((found?.n ?? 0) >= SOURCES_PER_WORKSPACE) {
			throw new SourceLimit();
		}
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
				if (action.input.teamId !== undefined) requireTeam(action.input.teamId);
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
			break;
		case "finishRemoval":
			if (!row.removing) throw new MutationRejected("invalid", "Revoke the source's keys first");
			deleteSource(db, changes, source.id);
			audit(source, "source.deleted");
			break;
		case "checkKey":
			break;
		case "keyCreated":
			audit(source, "source.keyCreated");
			break;
		default:
			throw new MutationRejected("invalid", "This action needs the settings gateway");
	}
	return { ...changes.result(), source };
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
