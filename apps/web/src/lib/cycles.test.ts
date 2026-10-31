import {
	type Activity,
	type ActivityChange,
	type Cycle,
	type Issue,
	startOfDay,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	burnUp,
	cycleName,
	cycleProgress,
	nextMonday,
	relativeCycles,
	startProblem,
	suggestedStart,
} from "./cycles";

const ZONE = "Europe/Istanbul";
const team = { cycles: { weeks: 1, timeZone: ZONE } };
const teams = new Map([["t1", team]]);

function cycle(id: string, number: number, startsOn: string, endsOn: string): Cycle {
	return {
		id,
		teamId: "t1",
		number,
		name: null,
		startsOn,
		endsOn,
		completedAt: null,
		createdAt: 0,
		updatedAt: 0,
	};
}

function issue(id: string, fields: Partial<Issue> = {}): Issue {
	return {
		id,
		teamId: "t1",
		number: 1,
		title: id,
		description: null,
		status: "todo",
		priority: 0,
		assigneeId: null,
		creatorId: "u1",
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		labelIds: [],
		sortOrder: "a0",
		version: 1,
		createdAt: 0,
		updatedAt: 0,
		...fields,
	};
}

let activityId = 0;
function activity(issueId: string, at: number, change: ActivityChange): Activity {
	activityId += 1;
	return {
		id: `a${activityId}`,
		issueId,
		actorId: "u1",
		change,
		proposedBy: null,
		source: null,
		createdAt: at,
		updatedAt: at,
	};
}

/** Noon on a day of the cycle, in its time zone. */
const noon = (day: string) => startOfDay(ZONE, day) + 12 * 60 * 60 * 1000;

describe("cycles", () => {
	it("are called by their name, or by their number", () => {
		expect(cycleName({ name: null, number: 3 })).toBe("Cycle 3");
		expect(cycleName({ name: "Launch", number: 3 })).toBe("Launch");
	});

	it("know each team's current and next cycle, in the team's time zone", () => {
		const cycles = [
			cycle("c1", 1, "2026-10-26", "2026-11-01"),
			cycle("c2", 2, "2026-11-02", "2026-11-08"),
			cycle("c3", 3, "2026-11-09", "2026-11-15"),
		];
		// Late on Sunday in UTC is already Monday in Istanbul.
		const relative = relativeCycles(cycles, teams, Date.UTC(2026, 10, 1, 22));
		expect([...relative.current]).toEqual(["c2"]);
		expect([...relative.next]).toEqual(["c3"]);
	});

	it("count progress in issues and points, leaving canceled issues out", () => {
		expect(
			cycleProgress([
				issue("a", { status: "done", estimate: 3 }),
				issue("b", { estimate: 5 }),
				issue("c", { status: "canceled", estimate: 8 }),
			]),
		).toEqual({ issues: { done: 1, total: 2 }, points: { done: 3, total: 8 } });
	});
});

describe("cycle settings", () => {
	const running = cycle("c1", 1, "2026-10-26", "2026-11-08");
	const next = cycle("c2", 2, "2026-11-09", "2026-11-22");

	it("start on a Monday at first", () => {
		expect(nextMonday("2026-10-31")).toBe("2026-11-02");
		expect(nextMonday("2026-11-02")).toBe("2026-11-02");
		expect(nextMonday("2026-11-01")).toBe("2026-11-02");
	});

	it("suggest where the next cycle starts now, or after the running one", () => {
		expect(suggestedStart([running, next], "2026-11-03")).toBe("2026-11-09");
		expect(suggestedStart([running], "2026-11-03")).toBe("2026-11-09");
		expect(suggestedStart([{ ...running, completedAt: 1 }], "2026-11-12")).toBe("2026-11-16");
	});

	it("turn down what the server would, in its words", () => {
		expect(startProblem([running, next], "2026-11-03", "2026-11-09", 2)).toBeNull();
		expect(startProblem([running, next], "2026-11-03", "2026-11-08", 2)).toBe(
			"The next cycle has to start after the current one ends: on 2026-11-09 or later",
		);
		// With no cycle running, a cycle may have started already, but not be over.
		expect(startProblem([], "2026-11-03", "2026-10-21", 2)).toBeNull();
		expect(startProblem([], "2026-11-03", "2026-10-20", 2)).toBe(
			"A cycle that starts then would be over already",
		);
		expect(startProblem([], "2026-11-03", "2027-11-05", 2)).toBe(
			"Cycles can start at most a year ahead",
		);
	});
});

describe("burnUp", () => {
	const current = cycle("c2", 2, "2026-11-02", "2026-11-08");

	it("follows the scope and what was done, day by day, from history", () => {
		const issues = [
			// In the cycle from the start, done on the third day.
			issue("planned", { cycleId: "c2", status: "done" }),
			// Added on the second day.
			issue("added", { cycleId: "c2" }),
			// In the cycle at first, moved out on the fourth day.
			issue("dropped", { cycleId: null }),
			// Canceled on the second day.
			issue("canceled", { cycleId: "c2", status: "canceled" }),
			// Never in the cycle.
			issue("elsewhere", { cycleId: "c1" }),
		];
		const activities = [
			activity("added", noon("2026-11-03"), { type: "cycle", from: null, to: "c2" }),
			activity("planned", noon("2026-11-04"), { type: "status", from: "todo", to: "done" }),
			activity("dropped", noon("2026-11-05"), { type: "cycle", from: "c2", to: null }),
			activity("canceled", noon("2026-11-03"), { type: "status", from: "todo", to: "canceled" }),
		];

		const days = burnUp(current, issues, activities, ZONE, noon("2026-11-06"));

		expect(days).toEqual([
			{ day: "2026-11-02", scope: 3, done: 0 },
			{ day: "2026-11-03", scope: 3, done: 0 },
			{ day: "2026-11-04", scope: 3, done: 1 },
			{ day: "2026-11-05", scope: 2, done: 1 },
			// Today, as it stands now.
			{ day: "2026-11-06", scope: 2, done: 1 },
		]);
	});

	it("leaves out issues made after a day, and stops at the cycle's last day", () => {
		const issues = [issue("late", { cycleId: "c2", createdAt: noon("2026-11-07") })];
		const days = burnUp(current, issues, [], ZONE, noon("2026-11-20"));
		expect(days.map((day) => day.scope)).toEqual([0, 0, 0, 0, 0, 1, 1]);
		expect(days.at(-1)?.day).toBe("2026-11-08");
	});

	it("sees a cycle that completed early as it was just before", () => {
		// The team stopped working in cycles on the fourth day: the cycle ended then, and its
		// unfinished issue left it at the same moment.
		const stopped = noon("2026-11-05");
		const ended = { ...current, endsOn: "2026-11-05", completedAt: stopped };
		const issues = [
			issue("open", { cycleId: null }),
			issue("shipped", { cycleId: "c2", status: "done" }),
		];
		const activities = [activity("open", stopped, { type: "cycle", from: "c2", to: null })];
		const days = burnUp(ended, issues, activities, ZONE, noon("2026-11-20"));
		expect(days.at(-1)).toEqual({ day: "2026-11-05", scope: 2, done: 1 });
	});

	it("is empty before the cycle starts", () => {
		expect(burnUp(current, [], [], ZONE, noon("2026-11-01"))).toEqual([]);
	});
});
