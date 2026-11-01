import type { IssueTemplate, Label, Member } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { applyTemplate, compareTemplates, type IssueDraft } from "./templates";

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
