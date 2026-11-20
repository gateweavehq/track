import { KEYS_PER_SOURCE, type SourceAction } from "@gateweave/track-protocol";
import type { WorkspaceDO } from "@gateweave/track-sync-server";
import type { Database } from "./db";
import { makeSourceKey, removeSourceKeys } from "./source-keys";

type Command = Parameters<WorkspaceDO["manageSource"]>[1];
type Outcome = ReturnType<WorkspaceDO["manageSource"]>;
export type SourceChangeResult =
	| { ok: true; value: { secret?: string } }
	| { ok: false; message: string; retryAfter?: number };

/** Two stores take part. A failed removal stays sealed until an admin finishes revoking its keys. */
export async function applySourceAction(
	db: Database,
	workspaceId: string,
	manage: (command: Command) => Promise<Outcome>,
	action: SourceAction,
): Promise<SourceChangeResult> {
	async function issueKey(id: string) {
		const key = await makeSourceKey(db, workspaceId, id);
		if (!key)
			return {
				ok: false as const,
				message: `A source can have ${KEYS_PER_SOURCE} keys. Revoke one first.`,
			};
		try {
			const audit = await manage({ kind: "keyCreated", id });
			if (audit.ok) return { ok: true as const, value: { secret: key.secret } };
			// A deletion may have passed the earlier check and already removed all its keys.
			await removeSourceKeys(db, workspaceId, id, key.id);
			return audit;
		} catch (error) {
			await removeSourceKeys(db, workspaceId, id, key.id);
			throw error;
		}
	}
	const done = { ok: true as const, value: {} };
	switch (action.kind) {
		case "create": {
			const made = await manage(action);
			if (!made.ok) return made;
			// If D1 is unavailable, settings still shows the source. Its first key can be made there.
			return issueKey(made.value.id);
		}
		case "makeKey":
		case "revokeKey": {
			const allowed = await manage({ kind: "checkKey", id: action.id });
			if (!allowed.ok) return allowed;
			if (action.kind === "makeKey") return issueKey(action.id);
			const removed = await removeSourceKeys(db, workspaceId, action.id, action.keyId);
			if (removed.meta.changes === 0) return { ok: false, message: "Key not found" };
			const audit = await manage({ kind: "keyRevoked", id: action.id });
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
