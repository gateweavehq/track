import type { Issue, Proposal } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { groupProposals, proposingAgents } from "./proposals";

function issue(id: string, updatedAt: number): Issue {
	return {
		id,
		teamId: "team",
		number: 1,
		title: id,
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
		updatedAt,
	};
}

function proposal(id: string, issueId: string, agentId: string, createdAt = 0): Proposal {
	return {
		id,
		issueId,
		agentId,
		change: { type: "priority", to: 1 },
		createdAt,
		updatedAt: createdAt,
	};
}

const issues = new Map([
	["old", issue("old", 10)],
	["new", issue("new", 20)],
]);

describe("groupProposals", () => {
	it("groups by issue with the most recently touched issue first", () => {
		const groups = groupProposals(
			[proposal("p1", "old", "a"), proposal("p2", "new", "a"), proposal("p3", "old", "b")],
			issues,
		);
		expect(groups.map((group) => group.issue.id)).toEqual(["new", "old"]);
		expect(groups[1]?.proposals.map((p) => p.id)).toEqual(["p1", "p3"]);
	});

	it("keeps an issue's proposals oldest first", () => {
		const groups = groupProposals(
			[proposal("late", "new", "a", 5), proposal("early", "new", "b", 1)],
			issues,
		);
		expect(groups[0]?.proposals.map((p) => p.id)).toEqual(["early", "late"]);
	});

	it("orders issues with the same activity by id", () => {
		const tied = new Map([
			["b", issue("b", 1)],
			["a", issue("a", 1)],
		]);
		const groups = groupProposals([proposal("p1", "b", "x"), proposal("p2", "a", "x")], tied);
		expect(groups.map((group) => group.issue.id)).toEqual(["a", "b"]);
	});

	it("filters by agent", () => {
		const all = [proposal("p1", "old", "a"), proposal("p2", "new", "b")];
		const groups = groupProposals(all, issues, "b");
		expect(groups.map((group) => group.issue.id)).toEqual(["new"]);
		expect(groupProposals(all, issues, "nobody")).toEqual([]);
	});

	it("leaves out proposals of issues it does not hold", () => {
		expect(groupProposals([proposal("p1", "gone", "a")], issues)).toEqual([]);
	});
});

describe("proposingAgents", () => {
	it("lists each agent once", () => {
		const all = [
			proposal("p1", "old", "a"),
			proposal("p2", "new", "b"),
			proposal("p3", "new", "a"),
		];
		expect(proposingAgents(all)).toEqual(["a", "b"]);
		expect(proposingAgents([])).toEqual([]);
	});
});
