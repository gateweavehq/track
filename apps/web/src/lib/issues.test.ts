import type { Issue } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	BOARD_STATUS_ORDER,
	compareIssues,
	groupByStatus,
	issueKey,
	LIST_STATUS_ORDER,
	matchesQuery,
	parseIssueKey,
	planMove,
	sortOrderAfter,
	sortOrderAt,
} from "./issues";

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
		labelIds: [],
		creatorId: "user",
		sortOrder: "a0",
		version: 1,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("issue keys", () => {
	it("formats and parses a key", () => {
		expect(issueKey({ key: "ENG" }, { number: 42 })).toBe("ENG-42");
		expect(parseIssueKey("ENG-42")).toEqual({ teamKey: "ENG", number: 42 });
	});

	it("accepts any case and surrounding space", () => {
		expect(parseIssueKey(" eng-7 ")).toEqual({ teamKey: "ENG", number: 7 });
	});

	it("rejects malformed keys", () => {
		for (const value of [
			"",
			"ENG",
			"ENG-",
			"ENG-0",
			"ENG-01",
			"1ENG-1",
			"TOOLONGKEY-1",
			"ENG-1-2",
		]) {
			expect(parseIssueKey(value)).toBeNull();
		}
	});

	it("marks a missing team instead of failing", () => {
		expect(issueKey(undefined, { number: 3 })).toBe("?-3");
	});
});

describe("ordering and grouping", () => {
	it("sorts by sort order, then by id", () => {
		const sorted = [
			issue({ id: "b", sortOrder: "a1" }),
			issue({ id: "c", sortOrder: "a0" }),
			issue({ id: "a", sortOrder: "a1" }),
		].sort(compareIssues);
		expect(sorted.map((i) => i.id)).toEqual(["c", "a", "b"]);
	});

	it("groups by status in list order, keeping every status", () => {
		const groups = groupByStatus([
			issue({ id: "done", status: "done" }),
			issue({ id: "doing-2", status: "in_progress", sortOrder: "a2" }),
			issue({ id: "doing-1", status: "in_progress", sortOrder: "a1" }),
		]);
		expect(groups.map((group) => group.status)).toEqual([...LIST_STATUS_ORDER]);
		expect(groups[0]?.issues.map((i) => i.id)).toEqual(["doing-1", "doing-2"]);
		expect(groups.find((group) => group.status === "done")?.issues).toHaveLength(1);
		expect(groups.find((group) => group.status === "todo")?.issues).toEqual([]);
	});

	it("places new issues after every existing one", () => {
		const existing = [
			issue({ sortOrder: "a5" }),
			issue({ sortOrder: "a9" }),
			issue({ sortOrder: "a1" }),
		];
		const next = sortOrderAfter(existing);
		expect(existing.every((i) => i.sortOrder < next)).toBe(true);
		expect(sortOrderAfter([])).toEqual(expect.any(String));
	});

	it("groups in a custom order", () => {
		const groups = groupByStatus([], BOARD_STATUS_ORDER);
		expect(groups.map((group) => group.status)).toEqual([...BOARD_STATUS_ORDER]);
	});
});

describe("moving issues", () => {
	const a = issue({ id: "a", sortOrder: "a1" });
	const b = issue({ id: "b", sortOrder: "a2" });
	const c = issue({ id: "c", sortOrder: "a3" });

	/** The ids in display order after applying a planned move. */
	function order(group: Issue[], moved: Issue, sortOrder: string) {
		return [...group.filter((i) => i.id !== moved.id), { ...moved, sortOrder }]
			.sort(compareIssues)
			.map((i) => i.id);
	}

	it("finds a key at the start, in between and at the end", () => {
		const sorted = [a, b, c];
		expect(sortOrderAt(sorted, 0) < "a1").toBe(true);
		const middle = sortOrderAt(sorted, 2);
		expect(middle > "a2" && middle < "a3").toBe(true);
		expect(sortOrderAt(sorted, 3) > "a3").toBe(true);
		expect(sortOrderAt([], 0)).toEqual(expect.any(String));
	});

	it("skips past issues that share a sort order", () => {
		const twins = [a, issue({ id: "x", sortOrder: "a2" }), issue({ id: "y", sortOrder: "a2" }), c];
		const key = sortOrderAt(twins, 2);
		expect(key > "a2" && key < "a3").toBe(true);
	});

	it("reorders within a status", () => {
		const down = planMove([a, b, c], a, "backlog", 2);
		expect(down).toEqual({ sortOrder: expect.any(String) });
		expect(order([a, b, c], a, down?.sortOrder ?? "")).toEqual(["b", "c", "a"]);

		const up = planMove([a, b, c], c, "backlog", 0);
		expect(order([a, b, c], c, up?.sortOrder ?? "")).toEqual(["c", "a", "b"]);
	});

	it("moves to another status at a position", () => {
		const moved = issue({ id: "m", status: "todo", sortOrder: "a9" });
		const plan = planMove([a, b, c], moved, "backlog", 1);
		expect(plan?.status).toBe("backlog");
		expect(order([a, b, c], moved, plan?.sortOrder ?? "")).toEqual(["a", "m", "b", "c"]);
	});

	it("does nothing when the issue stays where it is", () => {
		expect(planMove([a, b, c], b, "backlog", 1)).toBeNull();
	});

	it("clamps positions outside the group", () => {
		const plan = planMove([a, b, c], a, "backlog", 99);
		expect(order([a, b, c], a, plan?.sortOrder ?? "")).toEqual(["b", "c", "a"]);
		expect(planMove([a, b, c], a, "backlog", -5)).toBeNull();
	});
});

describe("matchesQuery", () => {
	it("matches every term in any field, ignoring case", () => {
		expect(matchesQuery("login eng-4", "ENG-4", "Fix login redirect")).toBe(true);
		expect(matchesQuery("LOGIN", "ENG-4", "Fix login redirect")).toBe(true);
	});

	it("requires all terms", () => {
		expect(matchesQuery("login signup", "ENG-4", "Fix login redirect")).toBe(false);
	});

	it("matches everything when the query is blank", () => {
		expect(matchesQuery("   ", "anything")).toBe(true);
	});
});
