import { KEYS_PER_SOURCE, type SourceAction } from "@gateweave/track-protocol";
import type { WorkspaceDO } from "@gateweave/track-sync-server";
import type { Database } from "./db";
import { makeSourceKey, removeSourceKeys, sourceKeys } from "./source-keys";

export type SourceCommand =
	| Parameters<WorkspaceDO["manageSource"]>[1]
	| Parameters<WorkspaceDO["revokeSourceKey"]>[1];
type Outcome = ReturnType<WorkspaceDO["manageSource"] | WorkspaceDO["revokeSourceKey"]>;
export type SourceChangeResult =
	| { ok: true; value: { secret?: string } }
	| { ok: false; message: string; retryAfter?: number };

/** Two stores take part. A failed removal stays sealed until an admin finishes revoking its keys. */
export async function applySourceAction(
	db: Database,
	workspaceId: string,
	manage: (command: SourceCommand) => Promise<Outcome>,
	action: SourceAction,
): Promise<SourceChangeResult> {
	async function issueKey(id: string) {
		const key = await makeSourceKey(db, workspaceId, id);
		if (!key)
			return {
				ok: false as const,
				message: `A source can have ${KEYS_PER_SOURCE} keys. Revoke one first.`,
			};
		let audit: Outcome;
		try {
			audit = await manage({ kind: "keyCreated", id });
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
			// If D1 is unavailable, settings still shows the source. Its first key can be made there.
			return issueKey(made.value.id);
		}
		case "makeKey": {
			const allowed = await manage({ kind: "checkKey", id: action.id });
			return allowed.ok ? issueKey(action.id) : allowed;
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
			const sealed = await manage({ kind: "prepareRemoval", id: action.id });
			if (!sealed.ok) return sealed;
			await removeSourceKeys(db, workspaceId, action.id);
			const removed = await manage({ kind: "finishRemoval", id: action.id });
			return removed.ok ? done : removed;
		}
		default: {
			const changed = await manage(action);
			return changed.ok ? done : changed;
		}
	}
}
