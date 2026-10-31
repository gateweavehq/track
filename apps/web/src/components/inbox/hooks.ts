import type { InboxItem } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "#/components/workspace/context";
import { nextReturn, unreadCount } from "#/lib/inbox";
import { send } from "#/lib/mutations";
import { useInbox, useInboxItem, useIssuesById } from "#/lib/queries";

/** setTimeout fires at once for delays past this. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * The time to sort the inbox into tabs by. It moves on when the items change and when a snoozed
 * item comes back, so that the item reappears on its own.
 */
export function useInboxClock(items: ReadonlyMap<string, InboxItem>): number {
	const [tick, setTick] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the clock is read again whenever the items change or the timer fires.
	const now = useMemo(() => Date.now(), [items, tick]);
	useEffect(() => {
		const next = nextReturn(items.values(), now);
		if (next === null) return;
		const timer = setTimeout(() => setTick((t) => t + 1), Math.min(next - now, MAX_TIMEOUT));
		return () => clearTimeout(timer);
	}, [items, now]);
	return now;
}

/** How many inbox items have unread news. Also shown on the installed app's icon. */
export function useUnreadInboxCount(): number {
	const items = useInbox();
	const issues = useIssuesById();
	const now = useInboxClock(items);
	const count = useMemo(() => unreadCount(items.values(), issues, now), [items, issues, now]);
	useEffect(() => {
		if (!("setAppBadge" in navigator)) return;
		const badge = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
		badge.catch(() => {
			// Not installed, or the platform has no badges.
		});
	}, [count]);
	return count;
}

/**
 * Marks the issue's inbox item read while the issue is on screen: when it opens, when news
 * arrives as it is read, and when the person comes back to the tab.
 */
export function useReadOnView(issueId: string): void {
	const client = useSyncClient();
	const { userId } = useWorkspace();
	const item = useInboxItem(issueId, userId);
	const unread = item !== undefined && item.unread > 0;
	const seen = item?.updatedAt ?? 0;

	useEffect(() => {
		if (!unread) return;
		const read = () => {
			if (document.visibilityState !== "visible") return;
			send(client, {
				name: "inbox.update",
				args: { items: [{ issueId, seen }], patch: { read: true } },
			});
		};
		read();
		document.addEventListener("visibilitychange", read);
		return () => document.removeEventListener("visibilitychange", read);
	}, [client, issueId, unread, seen]);
}
