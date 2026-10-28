import { mutationSchema } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { ISSUES, PEOPLE, type PersonKey, sampleSteps } from "./sample";

const people = Object.keys(PEOPLE) as PersonKey[];
const userIds = Object.fromEntries(people.map((key) => [key, `user-${key}`])) as Record<
	PersonKey,
	string
>;

function steps(extraIssues = 0) {
	let next = 0;
	return sampleSteps({ userIds, newId: () => `id-${++next}`, extraIssues });
}

describe("sampleSteps", () => {
	it("builds only mutations the protocol accepts", () => {
		for (const { mutation } of steps(5)) {
			expect(mutationSchema.safeParse(mutation).success, JSON.stringify(mutation)).toBe(true);
		}
	});

	it("creates teams and labels, as an admin, before anything refers to them", () => {
		const all = steps();
		const firstIssue = all.findIndex((step) => step.mutation.name === "issue.create");
		const before = all.slice(0, firstIssue);
		expect(before.every((step) => step.person === "maya")).toBe(true);
		expect(before.map((step) => step.mutation.name)).toEqual([
			...Array(3).fill("team.create"),
			...Array(7).fill("label.create"),
		]);
	});

	it("lists the sample issues in order, each before its comments", () => {
		const all = steps();
		const issues = all.filter((step) => step.mutation.name === "issue.create");
		expect(issues).toHaveLength(ISSUES.length);

		const created = new Set<string>();
		for (const { mutation } of all) {
			if (mutation.name === "issue.create") created.add(mutation.args.id);
			if (mutation.name === "comment.create") {
				expect(created.has(mutation.args.issueId)).toBe(true);
			}
		}
		const titles = issues.map(({ mutation }) =>
			mutation.name === "issue.create" ? mutation.args.title : "",
		);
		expect(titles).toEqual(ISSUES.map((issue) => issue.title));
	});

	it("assigns issues to the given users", () => {
		const assignees = new Set(
			steps().flatMap(({ mutation }) =>
				mutation.name === "issue.create" && mutation.args.assigneeId
					? [mutation.args.assigneeId]
					: [],
			),
		);
		expect([...assignees].sort()).toEqual(people.map((key) => userIds[key]).sort());
	});

	it("marks only generated filler as unordered, after everything else", () => {
		const all = steps(12);
		const unordered = all.filter((step) => step.parallel);
		expect(unordered).toHaveLength(12);
		expect(all.slice(-12)).toEqual(unordered);
		expect(steps().some((step) => step.parallel)).toBe(false);
	});
});
