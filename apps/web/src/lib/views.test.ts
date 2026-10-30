import { describe, expect, it } from "vitest";
import { issuePageSearch } from "./views";

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
