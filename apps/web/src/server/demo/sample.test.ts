import { mutationSchema } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { ISSUES, PEOPLE, type PersonKey, PROJECTS, sampleSteps } from "./sample";

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

	it("creates teams, labels and projects, as an admin, before anything refers to them", () => {
		const all = steps();
		const firstIssue = all.findIndex((step) => step.mutation.name === "issue.create");
		const before = all.slice(0, firstIssue);
		expect(before.every((step) => step.person === "maya")).toBe(true);
		expect(before.map((step) => step.mutation.name)).toEqual([
			...Array(3).fill("team.create"),
			"team.update",
			...Array(7).fill("label.create"),
			...Array(Object.keys(PROJECTS).length).fill("project.create"),
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

	it("puts sample issues in projects that exist, led by sample people", () => {
		const all = steps();
		const projects = all.flatMap(({ mutation }) =>
			mutation.name === "project.create" ? [mutation.args] : [],
		);
		expect(projects).toHaveLength(Object.keys(PROJECTS).length);
		for (const project of projects) {
			expect(Object.values(userIds)).toContain(project.leadId);
		}
		const ids = new Set(projects.map((project) => project.id));
		const inProjects = all.flatMap(({ mutation }) =>
			mutation.name === "issue.create" && mutation.args.projectId ? [mutation.args.projectId] : [],
		);
		expect(inProjects.length).toBeGreaterThan(Object.keys(PROJECTS).length);
		expect(inProjects.every((id) => ids.has(id))).toBe(true);
		expect(new Set(inProjects).size).toBe(ids.size);
	});

	it("counts target dates from the given day", () => {
		let next = 0;
		const all = sampleSteps({
			userIds,
			newId: () => `id-${++next}`,
			now: new Date("2026-11-30T12:00:00Z"),
		});
		const dates = all.flatMap(({ mutation }) =>
			mutation.name === "project.create" ? [mutation.args.targetDate] : [],
		);
		expect(dates).toContain("2027-01-14");
		expect(dates).toContain(null);
	});

	it("starts Engineering's cycles on the Monday of the given day", () => {
		for (const [day, monday] of [
			["2026-11-30T12:00:00Z", "2026-11-30"],
			["2026-12-06T23:00:00Z", "2026-11-30"],
		] as const) {
			let next = 0;
			const all = sampleSteps({ userIds, newId: () => `id-${++next}`, now: new Date(day) });
			const settings = all.flatMap(({ mutation }) =>
				mutation.name === "team.update" ? [mutation.args.patch.cycles] : [],
			);
			expect(settings).toEqual([{ weeks: 2, timeZone: "UTC", startsOn: monday }]);
		}
	});

	it("marks only generated filler as unordered, after everything else", () => {
		const all = steps(12);
		const unordered = all.filter((step) => step.parallel);
		expect(unordered).toHaveLength(12);
		expect(all.slice(-12)).toEqual(unordered);
		expect(steps().some((step) => step.parallel)).toBe(false);
	});
});
