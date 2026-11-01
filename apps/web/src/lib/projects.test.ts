import { defaultStatuses, type WorkflowStatus } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { compareProjects, isOverdue, progressPercent, projectProgress } from "./projects";

const of = (status: string) => ({ teamId: "t1", status });

describe("projectProgress", () => {
	it("counts done issues out of all that are not canceled", () => {
		const progress = projectProgress([
			of("done"),
			of("done"),
			of("in_progress"),
			of("backlog"),
			of("canceled"),
		]);
		expect(progress).toEqual({ done: 2, total: 4 });
		expect(progressPercent(progress)).toBe(50);
	});

	it("counts by category, so a team's own statuses count too", () => {
		const shipped: WorkflowStatus = {
			id: "t1/shipped",
			teamId: "t1",
			key: "shipped",
			name: "Shipped",
			category: "completed",
			color: null,
			sortOrder: "a1",
			createdAt: 1,
			updatedAt: 1,
			removedAt: null,
		};
		const statuses = new Map(
			[...defaultStatuses("t1", 1), shipped].map((status) => [status.id, status]),
		);
		expect(projectProgress([of("shipped"), of("done"), of("todo")], statuses)).toEqual({
			done: 2,
			total: 3,
		});
	});

	it("is at zero for a project with no issues, or only canceled ones", () => {
		expect(progressPercent(projectProgress([]))).toBe(0);
		expect(projectProgress([of("canceled")])).toEqual({ done: 0, total: 0 });
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
