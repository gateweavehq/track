import type { IssueTemplate, Label, Member } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	applyTemplate,
	compareTemplates,
	type IssueDraft,
	repeatLabel,
	sameRepeat,
} from "./templates";

function template(fields: Partial<IssueTemplate> = {}): IssueTemplate {
	return {
		id: "t1",
		teamId: "team",
		name: "Bug report",
		title: "Bug: ",
		description: "## Steps",
		priority: 2,
		labelIds: ["bug"],
		assigneeId: "maya",
		repeat: null,
		nextOn: null,
		createdAt: 0,
		updatedAt: 0,
		...fields,
	};
}

function member(id: string, removedAt: number | null = null): Member {
	return {
		id,
		name: id,
		email: `${id}@example.com`,
		image: null,
		role: "member",
		proposes: [],
		removedAt,
	};
}

const labels = new Map<string, Label>(
	["bug", "ui"].map((id) => [id, { id, name: id, color: "#e5484d", createdAt: 0, updatedAt: 0 }]),
);
const members = new Map([
	["maya", member("maya")],
	["sam", member("sam", 1)],
]);
const typed: IssueDraft = {
	title: "Login fails",
	description: "On Safari",
	priority: 4,
	assigneeId: null,
	labelIds: ["ui"],
};

describe("applyTemplate", () => {
	it("replaces the draft's fields with the template's", () => {
		expect(applyTemplate(typed, template(), labels, members)).toEqual({
			title: "Bug: ",
			description: "## Steps",
			priority: 2,
			assigneeId: "maya",
			labelIds: ["bug"],
		});
	});

	it("keeps what was typed where the template leaves the title or description empty", () => {
		const applied = applyTemplate(
			typed,
			template({ title: "  ", description: null }),
			labels,
			members,
		);
		expect(applied).toMatchObject({ title: "Login fails", description: "On Safari" });
		expect(applyTemplate(typed, template({ description: "" }), labels, members).description).toBe(
			"On Safari",
		);
	});

	it("leaves out a label deleted since and an assignee who left", () => {
		expect(
			applyTemplate(
				typed,
				template({ labelIds: ["gone", "ui"], assigneeId: "sam" }),
				labels,
				members,
			),
		).toMatchObject({ labelIds: ["ui"], assigneeId: null });
		expect(
			applyTemplate(typed, template({ assigneeId: "nobody" }), labels, members).assigneeId,
		).toBe(null);
	});
});

describe("compareTemplates", () => {
	it("orders by name", () => {
		const names = [template({ id: "a", name: "Chore" }), template({ id: "b", name: "Bug" })]
			.sort(compareTemplates)
			.map((each) => each.name);
		expect(names).toEqual(["Bug", "Chore"]);
	});
});

describe("schedules", () => {
	const weekly = { every: 1, unit: "week" as const, startsOn: "2026-11-02", timeZone: "UTC" };

	it("say how often they make an issue", () => {
		expect(repeatLabel(weekly)).toBe("Every week");
		expect(repeatLabel({ every: 3, unit: "month" })).toBe("Every 3 months");
	});

	it("are the same only when every part is", () => {
		expect(sameRepeat(null, null)).toBe(true);
		expect(sameRepeat(weekly, { ...weekly })).toBe(true);
		expect(sameRepeat(weekly, null)).toBe(false);
		expect(sameRepeat(weekly, { ...weekly, timeZone: "Europe/Istanbul" })).toBe(false);
		expect(sameRepeat(weekly, { ...weekly, every: 2 })).toBe(false);
	});
});
