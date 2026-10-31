import type { InboxItem, Issue } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	commentPreview,
	inboxEntries,
	nextReturn,
	snoozeOptions,
	tabOf,
	unreadCount,
} from "./inbox";

function issue(id: string): Issue {
	return {
		id,
		teamId: "team",
		number: 1,
		title: id,
		description: null,
		status: "backlog",
		priority: 0,
		assigneeId: null,
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		labelIds: [],
		creatorId: "user",
		sortOrder: "a0",
		version: 1,
		createdAt: 0,
		updatedAt: 0,
	};
}

function item(issueId: string, fields: Partial<InboxItem> = {}): InboxItem {
	return {
		id: `${issueId}/me`,
		issueId,
		memberId: "me",
		event: { type: "assigned" },
		actorId: "them",
		unread: 1,
		updatedAt: 10,
		snoozedUntil: null,
		archivedAt: null,
		...fields,
	};
}

const NOW = 1_000;
const issues = new Map(["a", "b", "c", "d", "e"].map((id) => [id, issue(id)]));

describe("inbox tabs", () => {
	const items = [
		item("a", { updatedAt: 20 }),
		item("b", { updatedAt: 30, unread: 0 }),
		item("c", { snoozedUntil: NOW + 500 }),
		item("d", { snoozedUntil: NOW + 100 }),
		item("e", { archivedAt: 5 }),
		// A snooze that has run out puts the item back.
		item("gone"),
	];

	it("puts each item on one tab", () => {
		expect(tabOf(item("x", { snoozedUntil: NOW - 1 }), NOW)).toBe("inbox");
		expect(tabOf(item("x", { snoozedUntil: NOW + 1 }), NOW)).toBe("snoozed");
		expect(tabOf(item("x", { snoozedUntil: NOW + 1, archivedAt: 1 }), NOW)).toBe("archived");
	});

	it("lists a tab's items with their issues, in its order", () => {
		const ids = (tab: "inbox" | "snoozed" | "archived") =>
			inboxEntries(items, issues, tab, NOW).map(({ item }) => item.issueId);
		expect(ids("inbox")).toEqual(["b", "a"]);
		expect(ids("snoozed")).toEqual(["d", "c"]);
		expect(ids("archived")).toEqual(["e"]);
	});

	it("counts unread items in the inbox only", () => {
		expect(unreadCount(items, issues, NOW)).toBe(1);
		expect(unreadCount(items, issues, NOW + 200)).toBe(2);
	});

	it("finds when the next snoozed item comes back", () => {
		expect(nextReturn(items, NOW)).toBe(NOW + 100);
		expect(nextReturn(items, NOW + 600)).toBeNull();
	});
});

describe("snoozeOptions", () => {
	it("offers a few hours, tomorrow morning and next Monday morning", () => {
		// A Wednesday afternoon.
		const now = new Date(2026, 10, 4, 15, 30);
		const [hours, tomorrow, week] = snoozeOptions(now).map((option) => new Date(option.until));
		expect(hours?.getTime()).toBe(now.getTime() + 3 * 60 * 60 * 1000);
		expect(tomorrow).toEqual(new Date(2026, 10, 5, 9));
		expect(week).toEqual(new Date(2026, 10, 9, 9));
	});

	it("puts next week a week away from a Monday, and a day away from a Sunday", () => {
		const week = (now: Date) => new Date(snoozeOptions(now)[2]?.until ?? 0);
		expect(week(new Date(2026, 10, 9, 8))).toEqual(new Date(2026, 10, 16, 9));
		expect(week(new Date(2026, 10, 8, 20))).toEqual(new Date(2026, 10, 9, 9));
	});
});

describe("commentPreview", () => {
	it("reads Markdown as plain words on one line", () => {
		expect(commentPreview("**Done** in [#12](https://x.test)\n\n`code` ![shot](a.png)")).toBe(
			"Done in #12 code shot",
		);
	});

	it("cuts long comments at a word", () => {
		const text = "word ".repeat(40);
		const preview = commentPreview(text, 22);
		expect(preview).toBe("word word word word…");
	});
});
