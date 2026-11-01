import { defaultStatuses, type WorkflowStatus } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	cannotRemove,
	defaultMoveTo,
	firstOfCategory,
	groupingTeams,
	isIssueClosed,
	moveStatus,
	type StatusMap,
	sortOrderAtEnd,
	statusColumns,
	statusName,
	statusOf,
	teamStatuses,
} from "./statuses";

function status(teamId: string, key: string, fields: Partial<WorkflowStatus> = {}) {
	return {
		id: `${teamId}/${key}`,
		teamId,
		key,
		name: key,
		category: "started",
		color: null,
		sortOrder: "a0",
		createdAt: 1,
		updatedAt: 1,
		removedAt: null,
		...fields,
	} satisfies WorkflowStatus;
}

function mapOf(...statuses: WorkflowStatus[]): StatusMap {
	return new Map(statuses.map((item) => [item.id, item]));
}

// Engineering adds QA after In Review and calls In Progress "Doing"; Design keeps the defaults
// but has removed Backlog.
const statuses = mapOf(
	...defaultStatuses("eng", 1).map((item) =>
		item.key === "in_progress" ? { ...item, name: "Doing" } : item,
	),
	status("eng", "qa", { name: "QA", sortOrder: "a2" }),
	status("eng", "shipped", { name: "Shipped", category: "completed", sortOrder: "a1" }),
	...defaultStatuses("design", 1).map((item) =>
		item.key === "backlog" ? { ...item, removedAt: 2 } : item,
	),
);

describe("statuses", () => {
	it("finds an issue's status in its own team", () => {
		expect(statusOf(statuses, { teamId: "eng", status: "in_progress" }).name).toBe("Doing");
		expect(statusOf(statuses, { teamId: "design", status: "in_progress" }).name).toBe(
			"In Progress",
		);
	});

	it("stands in for a status the copy does not have yet", () => {
		expect(statusOf(new Map(), { teamId: "eng", status: "done" })).toMatchObject({
			name: "Done",
			category: "completed",
		});
		expect(statusOf(new Map(), { teamId: "eng", status: "qa" })).toMatchObject({
			name: "qa",
			category: "backlog",
		});
	});

	it("closes issues by category, so a team's own statuses close them too", () => {
		expect(isIssueClosed(statuses, { teamId: "eng", status: "shipped" })).toBe(true);
		expect(isIssueClosed(statuses, { teamId: "eng", status: "canceled" })).toBe(true);
		expect(isIssueClosed(statuses, { teamId: "eng", status: "qa" })).toBe(false);
	});

	it("lists a team's live statuses in its order", () => {
		expect(teamStatuses(statuses, "eng").map((item) => item.key)).toEqual([
			"backlog",
			"todo",
			"in_progress",
			"in_review",
			"qa",
			"done",
			"shipped",
			"canceled",
		]);
		expect(teamStatuses(statuses, "design").map((item) => item.key)).not.toContain("backlog");
		expect(firstOfCategory(statuses, "eng", "completed")?.key).toBe("done");
		expect(firstOfCategory(statuses, "design", "backlog")).toBeUndefined();
	});

	it("groups teams' statuses by key, named as the first team names them", () => {
		expect(statusColumns(statuses, ["design", "eng"], "board").map((item) => item.name)).toEqual([
			"Backlog",
			"Todo",
			"In Progress",
			"In Review",
			"QA",
			"Done",
			"Shipped",
			"Canceled",
		]);
		expect(statusColumns(statuses, ["eng"], "list").map((item) => item.key)).toEqual([
			"in_progress",
			"in_review",
			"qa",
			"todo",
			"backlog",
			"done",
			"shipped",
			"canceled",
		]);
	});

	it("groups by the page's team, else by the teams with issues, else by every team", () => {
		const teams = new Map([
			["eng", { id: "eng", key: "ENG" }],
			["design", { id: "design", key: "DES" }],
			["ops", { id: "ops", key: "OPS" }],
		]);
		expect(groupingTeams([{ teamId: "eng" }], teams, "ops")).toEqual(["ops"]);
		expect(groupingTeams([{ teamId: "eng" }, { teamId: "design" }], teams, undefined)).toEqual([
			"design",
			"eng",
		]);
		expect(groupingTeams([], teams, undefined)).toEqual(["design", "eng", "ops"]);
	});

	it("names a key as a live status does, then as a removed one or the built-in", () => {
		expect(statusName(statuses, "qa")).toBe("QA");
		expect(statusName(mapOf(status("eng", "qa", { name: "QA", removedAt: 3 })), "qa")).toBe("QA");
		expect(statusName(new Map(), "in_review")).toBe("In Review");
		expect(statusName(new Map(), "later")).toBe("later");
	});

	it("puts a new status last in its category", () => {
		const eng = teamStatuses(statuses, "eng");
		const order = sortOrderAtEnd(eng, "started");
		const added = status("eng", "staging", { sortOrder: order });
		expect(teamStatuses(mapOf(...eng, added), "eng").map((item) => item.key)).toEqual([
			"backlog",
			"todo",
			"in_progress",
			"in_review",
			"qa",
			"staging",
			"done",
			"shipped",
			"canceled",
		]);
	});

	it("moves a status within its category, renumbering its category when orders tie", () => {
		const apply = (team: WorkflowStatus[], key: string, by: -1 | 1) => {
			const orders = new Map(moveStatus(team, key, by).map((item) => [item.key, item.sortOrder]));
			return teamStatuses(
				mapOf(
					...team.map((item) => ({ ...item, sortOrder: orders.get(item.key) ?? item.sortOrder })),
				),
				"eng",
			);
		};
		const eng = teamStatuses(statuses, "eng");
		expect(
			apply(eng, "qa", -1)
				.map((item) => item.key)
				.slice(2, 5),
		).toEqual(["in_progress", "qa", "in_review"]);
		expect(moveStatus(eng, "qa", 1)).toEqual([]);
		expect(moveStatus(eng, "in_progress", -1)).toEqual([]);

		// Two statuses with the same order sort by key; moving one between them renumbers all.
		const tied = [
			status("eng", "a", { sortOrder: "a0" }),
			status("eng", "b", { sortOrder: "a0" }),
			status("eng", "c", { sortOrder: "a1" }),
		];
		expect(apply(tied, "c", -1).map((item) => item.key)).toEqual(["a", "c", "b"]);
		// Only the orders that change are sent.
		expect(moveStatus(tied, "c", -1).map((item) => item.key)).toEqual(["b"]);
		expect(apply(tied, "a", 1).map((item) => item.key)).toEqual(["b", "a", "c"]);
	});

	it("keeps a completed status, and moves a removed status's issues to its kind", () => {
		const eng = teamStatuses(statuses, "eng");
		expect(cannotRemove(eng, "done")).toBeNull();
		expect(
			cannotRemove(
				eng.filter((item) => item.key !== "shipped"),
				"done",
			),
		).toBe("A team needs at least one completed status.");
		expect(defaultMoveTo(eng, "qa")).toBe("in_progress");
		expect(defaultMoveTo(eng, "backlog")).toBe("todo");
	});
});
