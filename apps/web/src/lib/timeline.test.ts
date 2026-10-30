import type { Issue } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	barColumns,
	daysBetween,
	draggedDates,
	dragPatch,
	initialWindowStart,
	issueSpan,
	isWeekend,
	monthSpans,
	timelineRows,
	weekStart,
	windowDays,
} from "./timeline";

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
		sortOrder: "a",
		startDate: null,
		dueDate: null,
		...overrides,
	} as Issue;
}

describe("the window", () => {
	it("starts weeks on Monday", () => {
		// 2026-11-04 is a Wednesday, 2026-11-08 a Sunday, 2026-11-09 a Monday.
		expect(weekStart("2026-11-04")).toBe("2026-11-02");
		expect(weekStart("2026-11-08")).toBe("2026-11-02");
		expect(weekStart("2026-11-09")).toBe("2026-11-09");
	});

	it("opens a week before today's, so today's week is in view", () => {
		expect(initialWindowStart("2026-11-04")).toBe("2026-10-26");
	});

	it("lists consecutive days across months and years", () => {
		const days = windowDays("2026-12-28", 6);
		expect(days).toEqual([
			"2026-12-28",
			"2026-12-29",
			"2026-12-30",
			"2026-12-31",
			"2027-01-01",
			"2027-01-02",
		]);
		expect(windowDays("2026-11-02")).toHaveLength(84);
	});

	it("knows weekends", () => {
		expect(isWeekend("2026-11-07")).toBe(true);
		expect(isWeekend("2026-11-08")).toBe(true);
		expect(isWeekend("2026-11-09")).toBe(false);
	});

	it("groups days into months for the header", () => {
		expect(monthSpans(windowDays("2026-10-29", 5))).toEqual([
			{ month: "2026-10", first: 0, count: 3 },
			{ month: "2026-11", first: 3, count: 2 },
		]);
	});

	it("counts days across a daylight saving change", () => {
		expect(daysBetween("2026-03-01", "2026-04-01")).toBe(31);
		expect(daysBetween("2026-04-01", "2026-03-01")).toBe(-31);
	});
});

describe("issueSpan", () => {
	it("spans start to due", () => {
		expect(issueSpan({ startDate: "2026-11-02", dueDate: "2026-11-06" })).toEqual({
			start: "2026-11-02",
			end: "2026-11-06",
		});
	});

	it("is one day for an issue with one date", () => {
		expect(issueSpan({ startDate: "2026-11-02", dueDate: null })).toEqual({
			start: "2026-11-02",
			end: "2026-11-02",
		});
		expect(issueSpan({ startDate: null, dueDate: "2026-11-06" })).toEqual({
			start: "2026-11-06",
			end: "2026-11-06",
		});
	});

	it("is null without dates, and never runs backwards", () => {
		expect(issueSpan({ startDate: null, dueDate: null })).toBeNull();
		expect(issueSpan({ startDate: "2026-11-06", dueDate: "2026-11-02" })).toEqual({
			start: "2026-11-02",
			end: "2026-11-06",
		});
	});
});

describe("timelineRows", () => {
	it("orders by start, then due date, and counts the undated", () => {
		const { rows, undated } = timelineRows([
			issue({ id: "late", startDate: "2026-11-09", dueDate: "2026-11-10" }),
			issue({ id: "none" }),
			issue({ id: "long", startDate: "2026-11-02", dueDate: "2026-11-20" }),
			issue({ id: "short", startDate: "2026-11-02", dueDate: "2026-11-03" }),
			issue({ id: "due-only", dueDate: "2026-11-01" }),
		]);
		expect(rows.map((row) => row.issue.id)).toEqual(["due-only", "short", "long", "late"]);
		expect(rows.map((row) => row.openEnded)).toEqual([true, false, false, false]);
		expect(undated).toBe(1);
	});
});

describe("barColumns", () => {
	const start = "2026-11-02";

	it("places a bar by its first and last day, both included", () => {
		expect(barColumns({ start: "2026-11-04", end: "2026-11-06" }, start)).toEqual({
			first: 2,
			last: 4,
			cutStart: false,
			cutEnd: false,
		});
		expect(barColumns({ start: "2026-11-02", end: "2026-11-02" }, start)).toMatchObject({
			first: 0,
			last: 0,
		});
	});

	it("clips a bar that starts before the window", () => {
		expect(barColumns({ start: "2026-10-20", end: "2026-11-04" }, start)).toEqual({
			first: 0,
			last: 2,
			cutStart: true,
			cutEnd: false,
		});
	});

	it("clips a bar that ends after the window", () => {
		// The 84-day window ends on 2027-01-24.
		expect(barColumns({ start: "2027-01-20", end: "2027-02-10" }, start)).toEqual({
			first: 79,
			last: 83,
			cutStart: false,
			cutEnd: true,
		});
	});

	it("cuts a bar that spans the whole window at both ends", () => {
		expect(barColumns({ start: "2026-01-01", end: "2027-12-31" }, start)).toEqual({
			first: 0,
			last: 83,
			cutStart: true,
			cutEnd: true,
		});
	});

	it("leaves out bars wholly outside the window", () => {
		expect(barColumns({ start: "2026-10-01", end: "2026-11-01" }, start)).toBeNull();
		expect(barColumns({ start: "2027-01-25", end: "2027-02-01" }, start)).toBeNull();
	});
});

describe("dragPatch", () => {
	const both = { startDate: "2026-11-02", dueDate: "2026-11-06" };

	it("moves both dates by whole days", () => {
		expect(dragPatch(both, "move", 3)).toEqual({ startDate: "2026-11-05", dueDate: "2026-11-09" });
		expect(dragPatch(both, "move", -3)).toEqual({ startDate: "2026-10-30", dueDate: "2026-11-03" });
	});

	it("moves an issue with one date without giving it the other", () => {
		expect(dragPatch({ startDate: "2026-11-02", dueDate: null }, "move", 2)).toEqual({
			startDate: "2026-11-04",
		});
		expect(dragPatch({ startDate: null, dueDate: "2026-11-06" }, "move", -2)).toEqual({
			dueDate: "2026-11-04",
		});
	});

	it("changes only the start from its edge, and stops at the due date", () => {
		expect(dragPatch(both, "start", -2)).toEqual({ startDate: "2026-10-31" });
		expect(dragPatch(both, "start", 2)).toEqual({ startDate: "2026-11-04" });
		expect(dragPatch(both, "start", 40)).toEqual({ startDate: "2026-11-06" });
	});

	it("changes only the due date from its edge, and stops at the start", () => {
		expect(dragPatch(both, "end", 4)).toEqual({ dueDate: "2026-11-10" });
		expect(dragPatch(both, "end", -2)).toEqual({ dueDate: "2026-11-04" });
		expect(dragPatch(both, "end", -40)).toEqual({ dueDate: "2026-11-02" });
	});

	it("is null when nothing changes", () => {
		expect(dragPatch(both, "move", 0)).toBeNull();
		expect(dragPatch(both, "end", 0)).toBeNull();
		// Already one day long: the start cannot pass the due date.
		expect(dragPatch({ startDate: "2026-11-02", dueDate: "2026-11-02" }, "start", 3)).toBeNull();
		expect(dragPatch({ startDate: null, dueDate: null }, "move", 3)).toBeNull();
	});

	it("gives an issue with one date its second from an edge", () => {
		expect(dragPatch({ startDate: "2026-11-02", dueDate: null }, "end", 3)).toEqual({
			dueDate: "2026-11-05",
		});
		expect(dragPatch({ startDate: null, dueDate: "2026-11-06" }, "start", -3)).toEqual({
			startDate: "2026-11-03",
		});
		// There is nothing to the left of a start date alone.
		expect(dragPatch({ startDate: "2026-11-02", dueDate: null }, "end", -3)).toBeNull();
	});

	it("shows the dates a drag would write", () => {
		expect(draggedDates(both, "end", 2)).toEqual({
			startDate: "2026-11-02",
			dueDate: "2026-11-08",
		});
		expect(draggedDates(both, "end", 0)).toEqual(both);
	});
});
