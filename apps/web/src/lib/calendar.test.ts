import type { Issue } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { addMonths, agendaDays, groupByDueDate, monthOf, monthWeeks } from "./calendar";

function issue(overrides: Partial<Issue>): Issue {
	return {
		id: "id",
		teamId: "team",
		number: 1,
		title: "Title",
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
		...overrides,
	};
}

describe("monthWeeks", () => {
	it("starts weeks on Monday and fills them with the neighboring months", () => {
		// November 2026 starts on a Sunday and ends on a Monday: six weeks.
		const weeks = monthWeeks("2026-11");
		expect(weeks).toHaveLength(6);
		expect(weeks[0]).toEqual([
			"2026-10-26",
			"2026-10-27",
			"2026-10-28",
			"2026-10-29",
			"2026-10-30",
			"2026-10-31",
			"2026-11-01",
		]);
		expect(weeks[5]?.[0]).toBe("2026-11-30");
		expect(weeks[5]?.[6]).toBe("2026-12-06");
	});

	it("takes four weeks for a February that starts on a Monday", () => {
		// February 2027 starts on a Monday and has 28 days.
		const weeks = monthWeeks("2027-02");
		expect(weeks).toHaveLength(4);
		expect(weeks[0]?.[0]).toBe("2027-02-01");
		expect(weeks[3]?.[6]).toBe("2027-02-28");
	});

	it("covers every day of the month exactly once, in whole weeks, across a year end", () => {
		const days = monthWeeks("2026-12").flat();
		expect(days.length % 7).toBe(0);
		expect(new Set(days).size).toBe(days.length);
		expect(days.filter((day) => monthOf(day) === "2026-12")).toHaveLength(31);
		expect(days.at(-1)).toBe("2027-01-03");
	});

	it("handles leap days", () => {
		expect(monthWeeks("2028-02").flat()).toContain("2028-02-29");
	});

	it("returns nothing for a malformed month", () => {
		expect(monthWeeks("nonsense")).toEqual([]);
	});
});

describe("addMonths", () => {
	it("moves across year ends in both directions", () => {
		expect(addMonths("2026-12", 1)).toBe("2027-01");
		expect(addMonths("2026-01", -1)).toBe("2025-12");
		expect(addMonths("2026-11", 0)).toBe("2026-11");
		expect(addMonths("2026-01", 14)).toBe("2027-03");
	});
});

describe("groupByDueDate", () => {
	it("groups by due date in list order and counts the undated", () => {
		const { byDay, undated } = groupByDueDate([
			issue({ id: "a", status: "done", dueDate: "2026-11-02", sortOrder: "a0" }),
			issue({ id: "b", status: "in_progress", dueDate: "2026-11-02", sortOrder: "a2" }),
			issue({ id: "c", status: "in_progress", dueDate: "2026-11-02", sortOrder: "a1" }),
			issue({ id: "d", dueDate: "2026-11-09" }),
			issue({ id: "e" }),
			issue({ id: "f" }),
		]);
		expect(byDay.get("2026-11-02")?.map(({ id }) => id)).toEqual(["c", "b", "a"]);
		expect(byDay.get("2026-11-09")?.map(({ id }) => id)).toEqual(["d"]);
		expect(undated).toBe(2);
	});

	it("does not change its input", () => {
		const issues = [issue({ id: "b", sortOrder: "a1" }), issue({ id: "a", sortOrder: "a0" })];
		groupByDueDate(issues);
		expect(issues.map(({ id }) => id)).toEqual(["b", "a"]);
	});
});

describe("agendaDays", () => {
	it("lists the days of the month that have issues, earliest first", () => {
		const { byDay } = groupByDueDate([
			issue({ id: "a", dueDate: "2026-11-20" }),
			issue({ id: "b", dueDate: "2026-11-03" }),
			issue({ id: "c", dueDate: "2026-12-01" }),
		]);
		expect(agendaDays("2026-11", byDay)).toEqual(["2026-11-03", "2026-11-20"]);
	});
});
