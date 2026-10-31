import { describe, expect, it } from "vitest";
import { filtersFromSearch, issuePageSearch, searchFromFilters } from "./views";

describe("issuePageSearch", () => {
	it("reads the view and the filters", () => {
		expect(
			issuePageSearch.parse({ view: "board", labels: ["label-bug", "label-docs"], due: "overdue" }),
		).toEqual({
			view: "board",
			labels: ["label-bug", "label-docs"],
			due: "overdue",
		});
		expect(issuePageSearch.parse({})).toEqual({});
	});

	it("drops malformed values instead of failing the page", () => {
		expect(
			issuePageSearch.parse({ view: "gantt", labels: "label-bug", due: "soon", other: "kept out" }),
		).toEqual({ view: undefined, labels: undefined, due: undefined });
		expect(issuePageSearch.parse({ labels: [42] }).labels).toBeUndefined();
		expect(issuePageSearch.parse({ labels: Array(51).fill("label") }).labels).toBeUndefined();
	});
});

describe("filters in the search params", () => {
	it("reads every filter under its short name, and writes them back", () => {
		const search = issuePageSearch.parse({
			status: ["todo", "in_progress"],
			priority: [1, 2],
			assignee: [null, "u1"],
			project: ["p1"],
			cycle: ["current", null, "c1"],
			team: ["t1"],
			labels: ["bug"],
			due: "week",
		});
		const filters = filtersFromSearch(search);
		expect(filters).toEqual({
			statuses: ["todo", "in_progress"],
			priorities: [1, 2],
			assigneeIds: [null, "u1"],
			projectIds: ["p1"],
			cycles: ["current", null, "c1"],
			teamIds: ["t1"],
			labelIds: ["bug"],
			due: "week",
		});
		expect(searchFromFilters(filters)).toEqual({ ...search, view: undefined });
	});

	it("names every filter when writing, so merging clears the ones that went", () => {
		expect(searchFromFilters({ statuses: ["done"] })).toEqual({
			team: undefined,
			status: ["done"],
			priority: undefined,
			assignee: undefined,
			project: undefined,
			cycle: undefined,
			labels: undefined,
			due: undefined,
		});
	});

	it("drops a filter it cannot read", () => {
		expect(issuePageSearch.parse({ status: ["soon"], priority: [9], assignee: [] })).toEqual({
			status: undefined,
			priority: undefined,
			assignee: undefined,
		});
	});
});
