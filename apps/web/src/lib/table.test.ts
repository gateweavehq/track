import type { Issue } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { nextSort, type SortColumn, type SortLookups, sortIssues } from "./table";

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
	return {
		id,
		teamId: "eng",
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
		sortOrder: id,
		version: 1,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

const lookups: SortLookups = {
	teams: new Map([
		["eng", { key: "ENG" }],
		["des", { key: "DES" }],
	]),
	members: new Map([
		["ada", { name: "Ada" }],
		["bo", { name: "bo" }],
		["cy", { name: "Cy" }],
	]),
	projects: new Map([
		["launch", { name: "Launch" }],
		["docs", { name: "Docs" }],
	]),
};

function ids(
	issues: Issue[],
	column: SortColumn | null,
	direction: "asc" | "desc" = "asc",
): string[] {
	const sort = column ? { column, direction } : null;
	return sortIssues(issues, sort, lookups).map((entry) => entry.id);
}

describe("sortIssues", () => {
	it("keeps the list's manual order without a sort", () => {
		const issues = [issue("c"), issue("a"), issue("b")];
		expect(ids(issues, null)).toEqual(["a", "b", "c"]);
	});

	it("does not change the issues it is given", () => {
		const issues = [issue("b"), issue("a")];
		sortIssues(issues, { column: "title", direction: "asc" }, lookups);
		expect(issues.map((entry) => entry.id)).toEqual(["b", "a"]);
	});

	it("puts empty values last in both directions", () => {
		const issues = [
			issue("none", { dueDate: null }),
			issue("late", { dueDate: "2026-12-01" }),
			issue("soon", { dueDate: "2026-11-01" }),
		];
		expect(ids(issues, "dueDate", "asc")).toEqual(["soon", "late", "none"]);
		expect(ids(issues, "dueDate", "desc")).toEqual(["late", "soon", "none"]);
	});

	it("treats no priority as empty and follows PRIORITY_ORDER otherwise", () => {
		const issues = [
			issue("none", { priority: 0 }),
			issue("low", { priority: 4 }),
			issue("urgent", { priority: 1 }),
			issue("medium", { priority: 3 }),
			issue("high", { priority: 2 }),
		];
		expect(ids(issues, "priority", "asc")).toEqual(["urgent", "high", "medium", "low", "none"]);
		expect(ids(issues, "priority", "desc")).toEqual(["low", "medium", "high", "urgent", "none"]);
	});

	it("orders statuses along the workflow", () => {
		const issues = [
			issue("done", { status: "done" }),
			issue("todo", { status: "todo" }),
			issue("backlog", { status: "backlog" }),
			issue("review", { status: "in_review" }),
			issue("progress", { status: "in_progress" }),
			issue("canceled", { status: "canceled" }),
		];
		expect(ids(issues, "status")).toEqual([
			"backlog",
			"todo",
			"progress",
			"review",
			"done",
			"canceled",
		]);
	});

	it("sorts assignees and projects by name, ignoring case", () => {
		const issues = [
			issue("1", { assigneeId: "cy", projectId: "launch" }),
			issue("2", { assigneeId: "bo", projectId: null }),
			issue("3", { assigneeId: "ada", projectId: "docs" }),
			issue("4", { assigneeId: null, projectId: "launch" }),
		];
		expect(ids(issues, "assignee")).toEqual(["3", "2", "1", "4"]);
		expect(ids(issues, "assignee", "desc")).toEqual(["1", "2", "3", "4"]);
		expect(ids(issues, "project")).toEqual(["3", "1", "4", "2"]);
	});

	it("treats an assignee or project it cannot find as empty", () => {
		const issues = [issue("gone", { assigneeId: "left" }), issue("ada", { assigneeId: "ada" })];
		expect(ids(issues, "assignee", "desc")).toEqual(["ada", "gone"]);
	});

	it("sorts keys by team, then by number rather than by text", () => {
		const issues = [
			issue("eng10", { number: 10 }),
			issue("eng9", { number: 9 }),
			issue("des2", { teamId: "des", number: 2 }),
		];
		expect(ids(issues, "id")).toEqual(["des2", "eng9", "eng10"]);
	});

	it("sorts titles with numbers in them naturally", () => {
		const issues = [
			issue("a", { title: "Step 10" }),
			issue("b", { title: "step 2" }),
			issue("c", { title: "Alpha" }),
		];
		expect(ids(issues, "title")).toEqual(["c", "b", "a"]);
	});

	it("sorts estimates and timestamps as numbers", () => {
		const issues = [
			issue("big", { estimate: 13, createdAt: 30, updatedAt: 5 }),
			issue("small", { estimate: 2, createdAt: 100, updatedAt: 7 }),
			issue("none", { estimate: null, createdAt: 2, updatedAt: 1 }),
		];
		expect(ids(issues, "estimate")).toEqual(["small", "big", "none"]);
		expect(ids(issues, "estimate", "desc")).toEqual(["big", "small", "none"]);
		expect(ids(issues, "created")).toEqual(["none", "big", "small"]);
		expect(ids(issues, "updated", "desc")).toEqual(["small", "big", "none"]);
	});

	it("breaks ties with manual order in either direction", () => {
		const issues = [
			issue("b", { priority: 2 }),
			issue("a", { priority: 2 }),
			issue("c", { priority: 2 }),
		];
		expect(ids(issues, "priority", "asc")).toEqual(["a", "b", "c"]);
		expect(ids(issues, "priority", "desc")).toEqual(["a", "b", "c"]);
	});
});

describe("nextSort", () => {
	it("sorts ascending first, then reverses with every click", () => {
		const first = nextSort(null, "status");
		expect(first).toEqual({ column: "status", direction: "asc" });
		const second = nextSort(first, "status");
		expect(second).toEqual({ column: "status", direction: "desc" });
		expect(nextSort(second, "status")).toEqual(first);
	});

	it("starts another column ascending", () => {
		expect(nextSort({ column: "status", direction: "desc" }, "title")).toEqual({
			column: "title",
			direction: "asc",
		});
	});
});
