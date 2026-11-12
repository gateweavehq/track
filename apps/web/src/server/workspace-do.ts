import { env } from "cloudflare:workers";
import {
	type InboxDigest,
	type PushNotice,
	type RequesterNotice,
	WorkspaceDO as SyncWorkspaceDO,
} from "@gateweave/track-sync-server";
import { emailInboxDigest } from "./inbox-email";
import { pushInboxNews } from "./push";
import { emailRequester } from "./requester-email";

/**
 * A workspace's Durable Object, as `sync-server` defines it, with what only the app can do: email
 * people the inbox news they leave unread and push it to their devices, tell whoever filed a
 * request through a form or by email what the team decided, and check the GitHub App's deliveries
 * with its secret.
 */
export class WorkspaceDO extends SyncWorkspaceDO {
	protected override sendInboxDigest(digest: InboxDigest): Promise<void> {
		return emailInboxDigest(digest);
	}

	protected override sendPush(notice: PushNotice): Promise<void> {
		return pushInboxNews(notice);
	}

	protected override sendRequesterNotice(notice: RequesterNotice): Promise<void> {
		return emailRequester(notice);
	}

	protected override githubAppSecret(): string | null {
		return env.GITHUB_APP_WEBHOOK_SECRET || null;
	}
}
