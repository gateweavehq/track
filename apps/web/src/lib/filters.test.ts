import type { Issue, IssueFilters } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	activeFilters,
	compactFilters,
	defaultsFromFilters,
	hasFilters,
	matchesFilters,
	sameFilters,
	toggleValue,
} from "./filters";

const base: Issue = {
	id: "i1",
	teamId: "t1",
	number: 1,
	title: "Issue",
	description: null,
	status: "todo",
	priority: 2,
	assigneeId: "u1",
	creatorId: "u1",
	projectId: null,
	cycleId: null,
	parentId: null,
	startDate: null,
	dueDate: null,
	estimate: null,
	labelIds: ["bug"],
	sortOrder: "a0",
	version: 1,
	createdAt: 1,
	updatedAt: 1,
};

const targets = {
	teams: new Map([["t1", {}]]),
	members: new Map([["u1", {}]]),
	projects: new Map([["p1", {}]]),
	labels: new Map([
		["bug", {}],
		["docs", {}],
	]),
	cycles: new Map([["c1", {}]]),
};

describe("activeFilters", () => {
	it("keeps what resolves, drops repeats, and drops a filter whose values all went", () => {
		expect(
			activeFilters(
				{
					labelIds: ["gone"],
					assigneeIds: [null, "u1", "u1", "left"],
					projectIds: ["gone"],
					teamIds: ["t1"],
					statuses: ["todo"],
				},
				targets,
			),
		).toEqual({ assigneeIds: [null, "u1"], teamIds: ["t1"], statuses: ["todo"] });
	});
});

describe("matchesFilters", () => {
	it("takes any value within a filter and every filter set", () => {
		expect(matchesFilters(base, {})).toBe(true);
		expect(matchesFilters(base, { statuses: ["todo", "done"], priorities: [2] })).toBe(true);
		expect(matchesFilters(base, { statuses: ["todo"], priorities: [1] })).toBe(false);
		expect(matchesFilters(base, { labelIds: ["docs", "bug"] })).toBe(true);
		expect(matchesFilters(base, { labelIds: ["docs"] })).toBe(false);
		expect(matchesFilters(base, { teamIds: ["t2"] })).toBe(false);
	});

	it("finds issues without an assignee or a project with null", () => {
		expect(matchesFilters(base, { projectIds: [null] })).toBe(true);
		expect(matchesFilters(base, { assigneeIds: [null] })).toBe(false);
		expect(matchesFilters({ ...base, assigneeId: null }, { assigneeIds: [null, "u2"] })).toBe(true);
	});

	it("finds issues in cycles, by id, by where the cycle stands, or without one", () => {
		const inCycle = { ...base, cycleId: "c1" };
		const relative = { current: new Set(["c1"]), next: new Set(["c2"]) };
		expect(matchesFilters(inCycle, { cycles: ["c1"] })).toBe(true);
		expect(matchesFilters(inCycle, { cycles: ["current"] }, new Date(), relative)).toBe(true);
		expect(matchesFilters(inCycle, { cycles: ["next"] }, new Date(), relative)).toBe(false);
		expect(matchesFilters(base, { cycles: [null] })).toBe(true);
		expect(matchesFilters(base, { cycles: ["current"] }, new Date(), relative)).toBe(false);
		expect(activeFilters({ cycles: ["gone", "current", null, "c1"] }, targets)).toEqual({
			cycles: ["current", null, "c1"],
		});
		expect(defaultsFromFilters({ cycles: ["c1"] }).cycleId).toBe("c1");
		expect(defaultsFromFilters({ cycles: ["current"] }).cycleId).toBeUndefined();
	});

	it("applies the due-date filter in the viewer's day", () => {
		const now = new Date(2026, 4, 10, 12);
		expect(matchesFilters({ ...base, dueDate: "2026-05-09" }, { due: "overdue" }, now)).toBe(true);
		expect(matchesFilters({ ...base, dueDate: "2026-05-16" }, { due: "week" }, now)).toBe(true);
		expect(matchesFilters({ ...base, dueDate: "2026-05-17" }, { due: "week" }, now)).toBe(false);
		expect(matchesFilters(base, { due: "none" }, now)).toBe(true);
	});
});

describe("comparing and changing filters", () => {
	it("treats unset and empty alike, and ignores the order of values", () => {
		expect(compactFilters({ statuses: [], due: undefined, labelIds: ["bug"] })).toEqual({
			labelIds: ["bug"],
		});
		expect(hasFilters({ statuses: [] })).toBe(false);
		expect(
			sameFilters(
				{ statuses: ["todo", "done"], assigneeIds: [null, "u1"] },
				{ assigneeIds: ["u1", null], statuses: ["done", "todo"], labelIds: [] },
			),
		).toBe(true);
		expect(sameFilters({ priorities: [1] }, { priorities: [2] })).toBe(false);
	});

	it("adds a value, removes it, and leaves nothing set when the last goes", () => {
		expect(toggleValue(undefined, "todo")).toEqual(["todo"]);
		expect(toggleValue(["todo"], "done")).toEqual(["todo", "done"]);
		expect(toggleValue(["todo"], "todo")).toBeUndefined();
		expect(toggleValue<string | null>([null, "u1"], null)).toEqual(["u1"]);
	});
});

describe("defaultsFromFilters", () => {
	it("starts a new issue with each value a filter pins, so it passes the filters", () => {
		const filters: IssueFilters = {
			teamIds: ["t1"],
			statuses: ["todo", "in_progress"],
			priorities: [1],
			assigneeIds: [null],
			labelIds: ["bug", "ui"],
		};
		const defaults = defaultsFromFilters(filters);
		expect(defaults).toEqual({
			teamId: "t1",
			status: undefined,
			priority: 1,
			assigneeId: null,
			projectId: undefined,
			labelIds: ["bug", "ui"],
		});
		// What the filters leave open, such as the status here, takes any value that passes them.
		const issue: Issue = { ...base, ...defaults, status: "todo", projectId: null };
		expect(matchesFilters(issue, filters)).toBe(true);
	});

	it("leaves everything open without filters", () => {
		expect(Object.values(defaultsFromFilters({})).every((value) => value === undefined)).toBe(true);
	});
});
