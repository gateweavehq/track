import { mutationSchema } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	currentCycleId,
	ISSUES,
	PEOPLE,
	type PersonKey,
	PROJECTS,
	type SampleStep,
	sampleSteps,
	withCycle,
} from "./sample";

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

	it("plans some open and some done Engineering issues into the current cycle, once it exists", () => {
		const all = steps();
		const planned = all.filter((step) => step.needsCycle);
		const wanted = ISSUES.filter((issue) => issue.cycle === "current");
		expect(planned).toHaveLength(wanted.length);
		expect(wanted.every((issue) => issue.team === "ENG")).toBe(true);
		expect(wanted.some((issue) => issue.status === "done")).toBe(true);
		expect(wanted.some((issue) => issue.status !== "done")).toBe(true);

		// Each update follows its issue's creation, which follows the team update that makes cycles.
		const cyclesOn = all.findIndex((step) => step.mutation.name === "team.update");
		for (const step of planned) {
			expect(mutationSchema.safeParse(step.mutation).success).toBe(true);
			const { mutation } = step;
			if (mutation.name !== "issue.update") throw new Error("Expected an issue update");
			const created = all.findIndex(
				(other) =>
					other.mutation.name === "issue.create" && other.mutation.args.id === mutation.args.id,
			);
			expect(created).toBeGreaterThan(cyclesOn);
			expect(all.indexOf(step)).toBeGreaterThan(created);

			const sent = withCycle(step, "cycle-1").mutation;
			expect(sent.name === "issue.update" && sent.args.patch).toEqual({ cycleId: "cycle-1" });
		}
		expect(withCycle(all[0] as SampleStep, "cycle-1")).toBe(all[0]);
	});

	it("finds the Engineering cycle that is running", () => {
		const base = { name: null, number: 1, createdAt: 0, updatedAt: 0 };
		const workspace = {
			teams: [
				{ id: "t-ops", key: "OPS" },
				{ id: "t-eng", key: "ENG" },
			],
			cycles: [
				{
					...base,
					id: "past",
					teamId: "t-eng",
					startsOn: "2026-11-02",
					endsOn: "2026-11-15",
					completedAt: 1,
				},
				{
					...base,
					id: "now",
					teamId: "t-eng",
					startsOn: "2026-11-16",
					endsOn: "2026-11-29",
					completedAt: null,
				},
				{
					...base,
					id: "next",
					teamId: "t-eng",
					startsOn: "2026-11-30",
					endsOn: "2026-12-13",
					completedAt: null,
				},
				{
					...base,
					id: "other",
					teamId: "t-ops",
					startsOn: "2026-11-16",
					endsOn: "2026-11-29",
					completedAt: null,
				},
			],
		};
		expect(currentCycleId(workspace, new Date("2026-11-20T09:00:00Z"))).toBe("now");
		expect(() => currentCycleId(workspace, new Date("2027-03-01T00:00:00Z"))).toThrow(/no current/);
	});

	it("marks only generated filler as unordered, after everything else", () => {
		const all = steps(12);
		const unordered = all.filter((step) => step.parallel);
		expect(unordered).toHaveLength(12);
		expect(all.slice(-12)).toEqual(unordered);
		expect(steps().some((step) => step.parallel)).toBe(false);
	});
});
