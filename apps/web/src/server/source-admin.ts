import { KEYS_PER_SOURCE, type SourceAction } from "@gateweave/track-protocol";
import type { WorkspaceDO } from "@gateweave/track-sync-server";
import { inArray, sql } from "drizzle-orm";
import { type Database, schema } from "./db";
import { makeSourceKey, newSourceKey, removeSourceKeys, sourceKeys } from "./source-keys";

export type SourceCommand =
	| Parameters<WorkspaceDO["manageSource"]>[1]
	| Parameters<WorkspaceDO["revokeSourceKey"]>[1];
type Outcome = ReturnType<WorkspaceDO["manageSource"] | WorkspaceDO["revokeSourceKey"]>;
export type SourceChangeResult =
	/** `keyMissing`: the source was made but its first key was not; it is made with "Make key". */
	| { ok: true; value: { secret?: string; keyMissing?: true } }
	| { ok: false; message: string; retryAfter?: number };

/** Two stores take part. A failed removal stays sealed until an admin finishes revoking its keys. */
export async function applySourceAction(
	db: Database,
	workspaceId: string,
	manage: (command: SourceCommand) => Promise<Outcome>,
	action: SourceAction,
): Promise<SourceChangeResult> {
	async function issueKey(id: string, keyId?: string) {
		const key = await makeSourceKey(db, workspaceId, id, newSourceKey(keyId));
		if (!key)
			return {
				ok: false as const,
				message: `A source can have ${KEYS_PER_SOURCE} keys. Revoke one first.`,
			};
		let audit: Outcome;
		try {
			audit = await manage({ kind: "keyCreated", id, keyId: key.id });
		} catch (error) {
			await removeSourceKeys(db, workspaceId, id, key.id);
			throw error;
		}
		if (audit.ok) return { ok: true as const, value: { secret: key.secret } };
		// If cleanup fails, D1 still lists the key for an admin to revoke.
		await removeSourceKeys(db, workspaceId, id, key.id);
		return audit;
	}
	const done = { ok: true as const, value: {} };
	switch (action.kind) {
		case "create": {
			const made = await manage(action);
			if (!made.ok) return made;
			// The source exists from here on. If its first key fails, answer that the source was made,
			// so trying again makes a key on it ("Make key") rather than a second source. A failed
			// statement is logged where it failed (`createDb`).
			try {
				const key = await issueKey(made.value.id);
				if (key.ok) return key;
			} catch {}
			return { ok: true, value: { keyMissing: true } };
		}
		case "makeKey": {
			// Observe candidate ids before the generation check. A delayed rotation must
			// never delete keys created by a replacement after that check.
			const candidates = action.id.startsWith("import-")
				? await sourceKeys(db, workspaceId, action.id)
				: [];
			const allowed = await manage({ kind: "checkKey", id: action.id });
			if (allowed.ok && "generation" in allowed.value && allowed.value.generation) {
				const prefix = allowed.value.generation;
				const stale = candidates.filter((key) => !key.id.startsWith(prefix)).map((key) => key.id);
				if (stale.length)
					await removeSourceKeys(
						db,
						workspaceId,
						action.id,
						undefined,
						inArray(schema.sourceKey.id, stale),
					);
			}
			return allowed.ok
				? issueKey(action.id, "keyId" in allowed.value ? allowed.value.keyId : undefined)
				: allowed;
		}
		case "revokeKey": {
			const { id, keyId } = action;
			const listed = (await sourceKeys(db, workspaceId)).some(
				(k) => k.sourceId === id && k.id === keyId,
			);
			// Keep proof of the D1 row across a failed delete or a lost audit response.
			const allowed = await manage({ kind: "prepareRevoke", id, keyId, listed });
			if (!allowed.ok) return allowed;
			await removeSourceKeys(db, workspaceId, id, keyId);
			const audit = await manage({ kind: "keyRevoked", id, keyId });
			return audit.ok ? done : audit;
		}
		case "delete": {
			return deleteSource(db, workspaceId, action.id, manage);
		}
		default: {
			const changed = await manage(action);
			return changed.ok ? done : changed;
		}
	}
}

/** Seal before deleting keys, then finish through the same admin who started the removal. */
export async function deleteSource(
	db: Database,
	workspaceId: string,
	id: string,
	manage: (command: {
		kind: "prepareRemoval" | "finishRemoval";
		id: string;
		generation?: string;
	}) => Promise<Outcome>,
): Promise<SourceChangeResult> {
	const sealed = await manage({ kind: "prepareRemoval", id });
	if (!sealed.ok) return sealed;
	const generation = "generation" in sealed.value ? sealed.value.generation : undefined;
	await removeSourceKeys(
		db,
		workspaceId,
		id,
		undefined,
		generation ? sql`${schema.sourceKey.id} glob ${generation + "*"}` : undefined,
	);
	const removed = await manage({ kind: "finishRemoval", id, generation });
	return removed.ok ? { ok: true, value: {} } : removed;
}
