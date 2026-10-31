import type { Issue } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { groupFields, groupIssues, orderIssues, planGroupMove } from "./grouping";
import { compareIssues } from "./issues";

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
	return {
		id,
		teamId: "eng",
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
		sortOrder: id,
		version: 1,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

const lookups = {
	members: new Map([
		["zed", { name: "Zed" }],
		["amy", { name: "Amy" }],
	]),
	projects: new Map([
		["web", { name: "Website" }],
		["api", { name: "API" }],
	]),
};
const ids = (issues: readonly Issue[]) => issues.map((i) => i.id);

describe("ordering", () => {
	const issues = [
		issue("a", { priority: 0, dueDate: "2026-03-02", createdAt: 1, updatedAt: 30 }),
		issue("b", { priority: 3, dueDate: null, createdAt: 3, updatedAt: 10 }),
		issue("c", { priority: 1, dueDate: "2026-03-01", createdAt: 2, updatedAt: 20 }),
	];

	it("orders by priority from urgent, with no priority last", () => {
		expect(ids(orderIssues(issues, "priority"))).toEqual(["c", "b", "a"]);
	});

	it("orders by due date from the soonest, with no date last", () => {
		expect(ids(orderIssues(issues, "dueDate"))).toEqual(["c", "a", "b"]);
	});

	it("orders by created and updated from the newest", () => {
		expect(ids(orderIssues(issues, "created"))).toEqual(["b", "c", "a"]);
		expect(ids(orderIssues(issues, "updated"))).toEqual(["a", "c", "b"]);
	});

	it("is manual order by default, and breaks ties with it", () => {
		const shuffled = [issues[2], issues[0], issues[1]].filter((i) => i !== undefined);
		expect(ids(orderIssues(shuffled, "manual"))).toEqual(ids([...issues].sort(compareIssues)));
		const tied = [issue("y", { priority: 2 }), issue("x", { priority: 2 })];
		expect(ids(orderIssues(tied, "priority"))).toEqual(["x", "y"]);
	});
});

describe("grouping", () => {
	it("groups by status as before: every status, workflow order on a board", () => {
		const issues = [issue("a", { status: "done" }), issue("b", { status: "in_progress" })];
		const list = groupIssues(issues, "status", "manual", "list", lookups);
		expect(list.map((g) => g.value)).toEqual([
			"in_progress",
			"in_review",
			"todo",
			"backlog",
			"done",
			"canceled",
		]);
		expect(list[0]?.issues.map((i) => i.id)).toEqual(["b"]);
		const board = groupIssues(issues, "status", "manual", "board", lookups);
		expect(board[0]?.value).toBe("backlog");
	});

	it("groups by priority, urgent first and no priority last, keeping empty groups", () => {
		const groups = groupIssues(
			[issue("a", { priority: 4 }), issue("b", { priority: 1 }), issue("c")],
			"priority",
			"manual",
			"list",
			lookups,
		);
		expect(groups.map((g) => g.value)).toEqual([1, 2, 3, 4, 0]);
		expect(groups.map((g) => g.issues.length)).toEqual([1, 0, 0, 1, 1]);
	});

	it("groups by assignee: people by name, the unassigned last; a board always has them", () => {
		const issues = [
			issue("a", { assigneeId: "zed" }),
			issue("b", { assigneeId: "amy" }),
			issue("c", { assigneeId: "gone" }),
		];
		const list = groupIssues(issues, "assignee", "manual", "list", lookups);
		// An assignee who is no longer known is named by id.
		expect(list.map((g) => g.value)).toEqual(["amy", "gone", "zed"]);
		const board = groupIssues(issues, "assignee", "manual", "board", lookups);
		expect(board.map((g) => g.value)).toEqual(["amy", "gone", "zed", null]);
		expect(board.at(-1)?.issues).toEqual([]);
	});

	it("groups by project by name, and puts issues without one last", () => {
		const groups = groupIssues(
			[issue("a", { projectId: "web" }), issue("b"), issue("c", { projectId: "api" })],
			"project",
			"manual",
			"list",
			lookups,
		);
		expect(groups.map((g) => g.value)).toEqual(["api", "web", null]);
	});

	it("puts everything in one group without grouping", () => {
		const groups = groupIssues(
			[issue("b"), issue("a", { status: "done" })],
			"none",
			"manual",
			"list",
			lookups,
		);
		expect(groups).toHaveLength(1);
		expect(ids(groups[0]?.issues ?? [])).toEqual(["a", "b"]);
	});

	it("orders the issues within each group", () => {
		const groups = groupIssues(
			[
				issue("a", { priority: 3, assigneeId: "amy" }),
				issue("b", { priority: 1, assigneeId: "amy" }),
				issue("c", { priority: 2, assigneeId: "zed" }),
			],
			"assignee",
			"priority",
			"list",
			lookups,
		);
		expect(groups.map((g) => ids(g.issues))).toEqual([["b", "a"], ["c"]]);
	});

	it("names each group distinctly", () => {
		const keys = [
			...groupIssues([], "status", "manual", "list", lookups),
			...groupIssues([], "priority", "manual", "list", lookups),
			...groupIssues([issue("a")], "assignee", "manual", "board", lookups),
		].map((g) => g.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe("moving between groups", () => {
	const a = issue("a", { priority: 1, sortOrder: "a1" });
	const b = issue("b", { priority: 1, sortOrder: "a2" });
	const m = issue("m", { priority: 3, sortOrder: "a9" });
	const groups = groupIssues([a, b, m], "priority", "manual", "board", lookups);
	const urgent = groups.find((g) => g.value === 1);
	const medium = groups.find((g) => g.value === 3);

	it("says what a group sets on an issue", () => {
		expect(urgent && groupFields(urgent)).toEqual({ priority: 1 });
		const none = groupIssues([], "assignee", "manual", "board", lookups).at(-1);
		expect(none && groupFields(none)).toEqual({ assigneeId: null });
		const flat = groupIssues([], "none", "manual", "list", lookups)[0];
		expect(flat && groupFields(flat)).toEqual({});
	});

	it("sets the field and a place in manual order when moving to another group", () => {
		const plan = urgent && planGroupMove(urgent, m, 1, true);
		expect(plan).toEqual({ priority: 1, sortOrder: expect.any(String) });
		expect(plan?.sortOrder && plan.sortOrder > "a1" && plan.sortOrder < "a2").toBe(true);
	});

	it("only reorders within a group in manual order", () => {
		const plan = urgent && planGroupMove(urgent, a, 1, true);
		expect(plan).toEqual({ sortOrder: expect.any(String) });
		expect(urgent && planGroupMove(urgent, a, 0, true)).toBeNull();
		// In another order the position is the order's, so there is nothing to change.
		expect(urgent && planGroupMove(urgent, a, 1, false)).toBeNull();
	});

	it("moves to another group without touching the order when it is not manual", () => {
		expect(medium && planGroupMove(medium, a, 0, false)).toEqual({ priority: 3 });
	});
});
