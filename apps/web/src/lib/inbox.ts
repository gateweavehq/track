import type { InboxItem, Issue } from "@gateweave/track-protocol";
import { z } from "zod";

export const INBOX_TABS = ["inbox", "snoozed", "archived"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

/** Search params of the inbox page: which tab it shows. Malformed values are dropped. */
export const inboxSearch = z.object({
	tab: z.enum(["snoozed", "archived"]).optional().catch(undefined),
});

export interface InboxEntry {
	item: InboxItem;
	issue: Issue;
}

/** Which tab an item is on at `now`. */
export function tabOf(item: InboxItem, now: number): InboxTab {
	if (item.archivedAt !== null) return "archived";
	if (item.snoozedUntil !== null && item.snoozedUntil > now) return "snoozed";
	return "inbox";
}

/**
 * The items on a tab, with their issues. Items of issues the replica does not hold are left out:
 * the server drops them with their issue. Snoozed items come back soonest first; the others are
 * newest first. The id breaks ties so every client orders the page the same way.
 */
export function inboxEntries(
	items: Iterable<InboxItem>,
	issues: ReadonlyMap<string, Issue>,
	tab: InboxTab,
	now: number,
): InboxEntry[] {
	const entries: InboxEntry[] = [];
	for (const item of items) {
		const issue = issues.get(item.issueId);
		if (issue && tabOf(item, now) === tab) entries.push({ item, issue });
	}
	const order =
		tab === "snoozed"
			? (a: InboxItem, b: InboxItem) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0)
			: (a: InboxItem, b: InboxItem) => b.updatedAt - a.updatedAt;
	return entries.sort((a, b) => order(a.item, b.item) || a.item.id.localeCompare(b.item.id));
}

/** Items in the inbox, not snoozed or archived, that have news the member has not read. */
export function unreadCount(
	items: Iterable<InboxItem>,
	issues: ReadonlyMap<string, Issue>,
	now: number,
): number {
	let count = 0;
	for (const item of items) {
		if (item.unread > 0 && issues.has(item.issueId) && tabOf(item, now) === "inbox") count += 1;
	}
	return count;
}

/** When the next snoozed item comes back, or null when none is snoozed. */
export function nextReturn(items: Iterable<InboxItem>, now: number): number | null {
	let next: number | null = null;
	for (const item of items) {
		if (tabOf(item, now) !== "snoozed" || item.snoozedUntil === null) continue;
		if (next === null || item.snoozedUntil < next) next = item.snoozedUntil;
	}
	return next;
}

export interface SnoozeOption {
	label: string;
	until: number;
}

const HOUR = 60 * 60 * 1000;

/**
 * Times to snooze until, in the browser's time zone: a few hours from now, tomorrow morning, and
 * next Monday morning. Mornings are at 9.
 */
export function snoozeOptions(now = new Date()): SnoozeOption[] {
	const morning = (daysAhead: number) => {
		const day = new Date(now);
		day.setDate(day.getDate() + daysAhead);
		day.setHours(9, 0, 0, 0);
		return day.getTime();
	};
	// Monday is 1; from a Monday, that is a week away.
	const toMonday = (8 - now.getDay()) % 7 || 7;
	return [
		{ label: "In 3 hours", until: now.getTime() + 3 * HOUR },
		{ label: "Tomorrow", until: morning(1) },
		{ label: "Next week", until: morning(toMonday) },
	];
}

/** A comment as a line of plain text, for showing beside its item. */
export function commentPreview(body: string, length = 120): string {
	const flat = body
		// Images and links read as their text; code fences, emphasis and headings as plain words.
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^ {0,3}(?:#{1,6}|>)\s?/gm, "")
		.replace(/[`*_~]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (flat.length <= length) return flat;
	const cut = flat.slice(0, length);
	const space = cut.lastIndexOf(" ");
	return `${(space > length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
