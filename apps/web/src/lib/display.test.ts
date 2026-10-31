import {
	compactDisplay,
	displayToStore,
	ISSUE_PROPERTIES,
	sameDisplay,
	TABLE_COLUMNS,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	hasDisplay,
	shownColumns,
	shownProperties,
	sortFromParam,
	sortToParam,
	toggleColumn,
	toggleProperty,
} from "./display";

describe("display options", () => {
	it("treats nothing, null and the defaults alike", () => {
		expect(compactDisplay(null)).toEqual({});
		expect(
			compactDisplay({
				groupBy: "status",
				orderBy: "manual",
				properties: [...ISSUE_PROPERTIES],
				columns: [...TABLE_COLUMNS],
			}),
		).toEqual({});
		expect(displayToStore({ groupBy: "status" })).toBeNull();
		expect(displayToStore({ groupBy: "priority" })).toEqual({ groupBy: "priority" });
		expect(sameDisplay(null, { orderBy: "manual" })).toBe(true);
		expect(sameDisplay({ groupBy: "project" }, null)).toBe(false);
		expect(hasDisplay({ groupBy: "status" })).toBe(false);
		expect(hasDisplay({ sort: { column: "title", direction: "asc" } })).toBe(true);
	});

	it("keeps lists in a fixed order, so equal options compare equal", () => {
		const a = { properties: ["labels" as const, "id" as const], columns: ["status" as const] };
		const b = {
			properties: ["id" as const, "labels" as const],
			columns: ["title" as const, "status" as const, "id" as const],
		};
		expect(compactDisplay(a)).toEqual({
			properties: ["id", "labels"],
			columns: ["id", "title", "status"],
		});
		expect(sameDisplay(a, b)).toBe(true);
	});

	it("shows every property and column unless the options pick some", () => {
		expect([...shownProperties({})]).toEqual([...ISSUE_PROPERTIES]);
		expect(shownColumns({})).toEqual([...TABLE_COLUMNS]);
		expect(shownProperties({ properties: ["id"] })).toEqual(new Set(["id"]));
		// ID and Title cannot be hidden.
		expect(shownColumns({ columns: ["status"] })).toEqual(["id", "title", "status"]);
	});

	it("toggles a property or a column, and returns to the defaults when all are back", () => {
		const hidden = toggleProperty({}, "labels");
		expect(shownProperties(hidden).has("labels")).toBe(false);
		expect(shownProperties(hidden).has("id")).toBe(true);
		expect(toggleProperty(hidden, "labels")).toEqual({});

		const narrow = toggleColumn({}, "project");
		expect(shownColumns(narrow)).not.toContain("project");
		expect(shownColumns(narrow)).toContain("cycle");
		expect(toggleColumn(narrow, "project")).toEqual({});
	});

	it("writes a sort as one URL value, and reads back only real ones", () => {
		const sort = { column: "dueDate" as const, direction: "desc" as const };
		expect(sortToParam(sort)).toBe("dueDate.desc");
		expect(sortFromParam("dueDate.desc")).toEqual(sort);
		expect(sortToParam(undefined)).toBeUndefined();
		for (const bad of [undefined, "", "dueDate", "dueDate.up", "labels.asc", "dueDate.asc.x"]) {
			expect(sortFromParam(bad)).toBeUndefined();
		}
	});
});
