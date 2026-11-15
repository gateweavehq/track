import { mutationSchema } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { AGENT_EXAMPLE_ISSUE_KEY } from "../../lib/demo-links";
import {
	AGENT,
	AGENT_EXAMPLE,
	AGENT_KEY,
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
const agentId = "user-coder";

function steps(extraIssues = 0) {
	let next = 0;
	return sampleSteps({ userIds, newId: () => `id-${++next}`, extraIssues });
}

/** The steps for a workspace that has the sample's agent as a member. */
function stepsWithAgent(extraIssues = 0) {
	let next = 0;
	return sampleSteps({ userIds, agentId, newId: () => `id-${++next}`, extraIssues });
}

describe("sampleSteps", () => {
	it("builds only mutations the protocol accepts", () => {
		for (const { mutation } of [...steps(5), ...stepsWithAgent(5)]) {
			expect(mutationSchema.safeParse(mutation).success, JSON.stringify(mutation)).toBe(true);
		}
	});

	it("creates teams, their statuses, labels and projects, as an admin, before anything refers to them", () => {
		const all = steps();
		const firstIssue = all.findIndex((step) => step.mutation.name === "issue.create");
		const before = all.slice(0, firstIssue);
		expect(before.every((step) => step.by === "maya")).toBe(true);
		expect(before.map((step) => step.mutation.name)).toEqual([
			...Array(3).fill("team.create"),
			"team.update",
			"status.create",
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

		const withAgent = stepsWithAgent(12);
		expect(withAgent.slice(-12).every((step) => step.parallel)).toBe(true);
		expect(withAgent.slice(0, -12).some((step) => step.parallel)).toBe(false);
	});
});

describe("the agent's example", () => {
	/** The example issue's id, and every step that is about it or its agent, in order. */
	function example(all: SampleStep[]) {
		const created = all.find(
			({ mutation }) =>
				mutation.name === "issue.create" && mutation.args.title === AGENT_EXAMPLE.issue.title,
		);
		const id = created?.mutation.name === "issue.create" ? created.mutation.args.id : undefined;
		const story = all.filter(({ mutation }) => {
			if (mutation.name === "agent.update") return true;
			if (mutation.name === "issue.create" || mutation.name === "issue.update") {
				return mutation.args.id === id;
			}
			return mutation.name === "comment.create" && mutation.args.issueId === id;
		});
		return { id, story };
	}

	it("is left out of a workspace without the agent, whose steps are all the people's", () => {
		const all = steps(3);
		expect(example(all)).toEqual({ id: undefined, story: [] });
		expect(all.every((step) => step.by !== AGENT_KEY)).toBe(true);
		expect(JSON.stringify(all)).not.toContain(AGENT.name);
	});

	it("adds its steps without changing any other", () => {
		const withAgent = stepsWithAgent(3);
		const { story } = example(withAgent);
		const others = withAgent.filter((step) => !story.includes(step));
		const outline = (list: SampleStep[]) =>
			list.map((step) => `${step.by} ${step.mutation.name}${step.parallel ? " parallel" : ""}`);
		expect(outline(others)).toEqual(outline(steps(3)));
	});

	it("is filed last in its team, under the key the welcome card names", () => {
		const all = stepsWithAgent();
		const { id } = example(all);
		const team = all.flatMap(({ mutation }) =>
			mutation.name === "team.create" && mutation.args.key === AGENT_EXAMPLE.issue.team
				? [mutation.args]
				: [],
		)[0];
		// Issues are numbered per team, in the order they are created.
		const inTeam = all.flatMap(({ mutation }) =>
			mutation.name === "issue.create" && mutation.args.teamId === team?.id ? [mutation.args] : [],
		);
		expect(inTeam.at(-1)?.id).toBe(id);
		expect(`${team?.key}-${inTeam.length}`).toBe(AGENT_EXAMPLE_ISSUE_KEY);
		// Last in the manual order too, so no issue above it moves.
		const orders = inTeam.map((issue) => issue.sortOrder);
		expect([...orders].sort()).toEqual(orders);
	});

	it("tells what happened in order, each step by whoever made it", () => {
		const all = stepsWithAgent();
		const { id, story } = example(all);
		const project = all.flatMap(({ mutation }) =>
			mutation.name === "project.create" && mutation.args.name === PROJECTS.polish.name
				? [mutation.args.id]
				: [],
		)[0];
		const told = story.map(({ by, mutation }) => {
			if (mutation.name === "issue.create") {
				const { status, assigneeId, projectId } = mutation.args;
				return { by, filed: { status, assigneeId, projectId } };
			}
			if (mutation.name === "agent.update") return { by, agent: mutation.args };
			if (mutation.name === "issue.update") return { by, change: mutation.args.patch };
			return { by, comment: mutation.name === "comment.create" ? mutation.args.body : null };
		});
		expect(id).toBeDefined();
		expect(project).toBeDefined();
		expect(told).toEqual([
			{ by: "diego", filed: { status: "todo", assigneeId: null, projectId: null } },
			// An admin's setting, before the agent touches anything: it only proposes closing.
			{ by: "maya", agent: { id: agentId, patch: { proposes: ["close"] } } },
			{ by: "diego", change: { assigneeId: agentId } },
			{ by: AGENT_KEY, comment: expect.stringMatching(/^I'm on it\. /) },
			{ by: AGENT_KEY, change: { status: "in_progress" } },
			// A person's change between the agent's two moves, so the history keeps both.
			{ by: "diego", change: { projectId: project } },
			{ by: AGENT_KEY, comment: expect.stringMatching(/^The pull request is ready for review\. /) },
			{ by: AGENT_KEY, change: { status: "in_review" } },
			// Closing, which the workspace turns into a proposal.
			{ by: AGENT_KEY, change: { status: "done" } },
		]);
	});

	it("starts before the steps that wait for a cycle and finishes after them", () => {
		// The demo sends the steps in two calls, split at the first that waits for a cycle. Steps of
		// one call can share a time, so the example's two halves must not be in the same one.
		const all = stepsWithAgent();
		const { story } = example(all);
		const split = all.findIndex((step) => step.needsCycle);
		const half = (steps: SampleStep[]) =>
			steps.flatMap(({ by, mutation }) =>
				mutation.name === "comment.create" || mutation.name === "issue.update"
					? [`${by} ${mutation.name}`]
					: [],
			);
		expect(split).toBeGreaterThan(0);
		expect(half(story.filter((step) => all.indexOf(step) < split))).toEqual([
			"diego issue.update",
			`${AGENT_KEY} comment.create`,
			`${AGENT_KEY} issue.update`,
		]);
		expect(half(story.filter((step) => all.indexOf(step) > split))).toEqual([
			"diego issue.update",
			`${AGENT_KEY} comment.create`,
			`${AGENT_KEY} issue.update`,
			`${AGENT_KEY} issue.update`,
		]);
	});

	it("says first that it is sample data, and links to nothing but the recording", () => {
		const { description } = AGENT_EXAMPLE.issue;
		expect(description).toMatch(
			/^\*This issue shows what an agent member does in Track\. No agent runs here: .+\*\n\n/,
		);
		expect(description?.match(/https?:\/\/[^\s)]+/g)).toEqual([
			"https://gateweave.com/watch/issue-to-pull-request.mp4",
		]);
		// The agent's comments speak of a pull request that does not exist, so they point nowhere.
		const comments = [...AGENT_EXAMPLE.start, ...AGENT_EXAMPLE.finish].flatMap((step) =>
			"comment" in step ? [step] : [],
		);
		expect(comments.map((comment) => comment.by)).toEqual([AGENT_KEY, AGENT_KEY]);
		for (const { comment } of comments) expect(comment).not.toMatch(/https?:|www\.|#\d/);
	});
});
