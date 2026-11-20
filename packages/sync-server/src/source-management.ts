import {
	type AuditAction,
	SOURCES_PER_WORKSPACE,
	type Source,
	type SourceAction,
	sourceAction,
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
	const pending = "source-revoke:" + keyId;
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

export type SourceAdminAction =
	| Extract<SourceAction, { kind: "create" | "update" | "assign" | "pause" }>
	| z.infer<typeof internalAction>;

export function manageSource(db: Db, memberId: string, command: SourceAdminAction, now: number) {
	const parsed = z.union([sourceAction, internalAction]).safeParse(command);
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
		requireTeam(action.input.teamId);
		const found = db.select({ n: count() }).from(sources).get();
		if ((found?.n ?? 0) >= SOURCES_PER_WORKSPACE) {
			throw new SourceLimit();
		}
		const source = toSource(
			db
				.insert(sources)
				.values({
					...action.input,
					id: crypto.randomUUID(),
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
			for (const removed of db
				.delete(signals)
				.where(eq(signals.sourceId, row.id))
				.returning({ id: signals.id })
				.all()) {
				changes.delete("signal", removed.id);
			}
			db.delete(sources).where(eq(sources.id, row.id)).run();
			changes.delete("source", row.id);
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
