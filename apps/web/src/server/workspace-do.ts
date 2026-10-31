import { type InboxDigest, WorkspaceDO as SyncWorkspaceDO } from "@gateweave/track-sync-server";
import { emailInboxDigest } from "./inbox-email";

/**
 * A workspace's Durable Object, as `sync-server` defines it, with what only the app can do: email
 * people the inbox news they leave unread.
 */
export class WorkspaceDO extends SyncWorkspaceDO {
	protected override sendInboxDigest(digest: InboxDigest): Promise<void> {
		return emailInboxDigest(digest);
	}
}
