import { AUTOMATION_MONTH_MS, defaultStatuses, type Issue } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	automationChoices,
	closeTarget,
	dueToArchive,
	dueToClose,
	monthsLabel,
} from "./automations";

const NOW = 1_800_000_000_000;
const statuses = defaultStatuses("t1", 1);

/** An issue last touched this many months (and a minute) ago. */
function issue(id: string, status: string, months: number, fields: Partial<Issue> = {}): Issue {
	return {
		id,
		teamId: "t1",
		number: 1,
		title: id,
		description: null,
		status,
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
		updatedAt: NOW - months * AUTOMATION_MONTH_MS - 60_000,
		archivedAt: null,
		intake: false,
		...fields,
	};
}

const ids = (issues: Issue[]) => issues.map((each) => each.id);

describe("team automations", () => {
	const issues = [
		issue("done-old", "done", 6),
		issue("canceled-old", "canceled", 6),
		issue("done-recent", "done", 2),
		issue("done-archived", "done", 6, { archivedAt: NOW - 1 }),
		issue("backlog-old", "backlog", 6),
		issue("todo-old", "todo", 6),
		issue("started-old", "in_progress", 6),
		issue("backlog-recent", "backlog", 2),
	];

	it("archive closed issues nobody touched for the months", () => {
		expect(ids(dueToArchive(issues, statuses, 3, NOW))).toEqual(["done-old", "canceled-old"]);
		expect(ids(dueToArchive(issues, statuses, 1, NOW))).toEqual([
			"done-old",
			"canceled-old",
			"done-recent",
		]);
	});

	it("close issues nobody started, into the first canceled status, when there is one", () => {
		expect(ids(dueToClose(issues, statuses, 3, NOW))).toEqual(["backlog-old", "todo-old"]);
		expect(closeTarget(statuses)?.key).toBe("canceled");
		const noCanceled = statuses.filter((status) => status.category !== "canceled");
		expect(closeTarget(noCanceled)).toBeUndefined();
		expect(dueToClose(issues, noCanceled, 3, NOW)).toEqual([]);
	});

	it("offer the usual waits, and keep one set some other way", () => {
		expect(automationChoices(null)).toEqual([1, 3, 6, 12, 24]);
		expect(automationChoices(6)).toEqual([1, 3, 6, 12, 24]);
		expect(automationChoices(9)).toEqual([1, 3, 6, 9, 12, 24]);
		expect(monthsLabel(1)).toBe("1 month");
		expect(monthsLabel(12)).toBe("12 months");
	});
});
