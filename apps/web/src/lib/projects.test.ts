import { describe, expect, it } from "vitest";
import { compareProjects, isOverdue, progressPercent, projectProgress } from "./projects";

describe("projectProgress", () => {
	it("counts done issues out of all that are not canceled", () => {
		const progress = projectProgress([
			{ status: "done" },
			{ status: "done" },
			{ status: "in_progress" },
			{ status: "backlog" },
			{ status: "canceled" },
		]);
		expect(progress).toEqual({ done: 2, total: 4 });
		expect(progressPercent(progress)).toBe(50);
	});

	it("is at zero for a project with no issues, or only canceled ones", () => {
		expect(progressPercent(projectProgress([]))).toBe(0);
		expect(projectProgress([{ status: "canceled" }])).toEqual({ done: 0, total: 0 });
	});

	it("rounds to a whole percentage", () => {
		expect(progressPercent({ done: 1, total: 3 })).toBe(33);
		expect(progressPercent({ done: 2, total: 3 })).toBe(67);
		expect(progressPercent({ done: 3, total: 3 })).toBe(100);
	});
});

describe("compareProjects", () => {
	it("lists open work first, then by name", () => {
		const projects = [
			{ id: "1", name: "Beta", status: "completed" as const },
			{ id: "2", name: "alpha", status: "planned" as const },
			{ id: "3", name: "Zed", status: "started" as const },
			{ id: "4", name: "Able", status: "planned" as const },
		];
		expect(projects.sort(compareProjects).map((project) => project.id)).toEqual([
			"3",
			"4",
			"2",
			"1",
		]);
	});
});

describe("isOverdue", () => {
	it("calls an open project overdue once its day has passed", () => {
		const now = new Date(2026, 5, 15, 12);
		expect(isOverdue({ status: "started", targetDate: "2026-06-14" }, now)).toBe(true);
		expect(isOverdue({ status: "started", targetDate: "2026-06-15" }, now)).toBe(false);
		expect(isOverdue({ status: "completed", targetDate: "2026-06-14" }, now)).toBe(false);
		expect(isOverdue({ status: "canceled", targetDate: "2026-06-14" }, now)).toBe(false);
		expect(isOverdue({ status: "planned", targetDate: null }, now)).toBe(false);
	});
});
