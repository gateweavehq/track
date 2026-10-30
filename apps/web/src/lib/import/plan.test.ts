import type {
	Comment,
	Issue,
	Label,
	Member,
	MutationInput,
	Project,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	type ImportedIssue,
	type ImportSource,
	type ImportTarget,
	importId,
	planImport,
	runImport,
} from "./plan";

const ada: Member = {
	id: "u1",
	name: "Ada Lovelace",
	email: "ada@example.test",
	image: null,
	role: "owner",
	proposes: [],
	removedAt: null,
};
const bug: Label = { id: "l1", name: "Bug", color: "#e5484d", createdAt: 1, updatedAt: 1 };
const launch: Project = {
	id: "p1",
	name: "Launch",
	description: null,
	status: "started",
	leadId: null,
	targetDate: null,
	createdAt: 1,
	updatedAt: 1,
};

function imported(
	overrides: Partial<ImportedIssue> & Pick<ImportedIssue, "sourceId">,
): ImportedIssue {
	return {
		title: "Imported",
		description: null,
		status: "todo",
		priority: 0,
		labels: [],
		assignee: null,
		project: null,
		parentSourceId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		createdAt: null,
		url: null,
		reference: null,
		comments: [],
		...overrides,
	};
}

function target(issues: Issue[] = [], comments: Comment[] = []): ImportTarget {
	return {
		issues: new Map(issues.map((issue) => [issue.id, issue])),
		comments: new Map(comments.map((comment) => [comment.id, comment])),
		labels: [bug],
		projects: [launch],
		members: [ada],
	};
}

type ArgsOf<N extends MutationInput["name"]> = Extract<MutationInput, { name: N }>["args"];

function argsOf<N extends MutationInput["name"]>(plan: { mutations: MutationInput[] }, name: N) {
	return plan.mutations
		.filter((mutation) => mutation.name === name)
		.map((mutation) => mutation.args as ArgsOf<N>);
}

describe("planImport", () => {
	const github: ImportSource = {
		name: "GitHub",
		labelColors: new Map([["needs triage", "#ededed"]]),
		issues: [
			imported({
				sourceId: "github:1#2",
				title: "  Crash   on\nsave ",
				description: "It crashes.",
				labels: ["bug", "Needs triage", "needs triage"],
				assignee: { name: "octocat", email: null },
				project: "launch",
				createdAt: Date.UTC(2024, 0, 2),
				url: "https://github.com/acme/api/issues/2",
				reference: "acme/api#2",
				parentSourceId: "github:1#1",
				comments: [
					{
						sourceId: "github:c2",
						body: "Second",
						author: "octocat",
						createdAt: Date.UTC(2024, 0, 4),
					},
					{ sourceId: "github:c1", body: "First", author: null, createdAt: Date.UTC(2024, 0, 3) },
					{ sourceId: "github:c3", body: "   ", author: "x", createdAt: null },
				],
			}),
			imported({
				sourceId: "github:1#1",
				title: "Epic",
				assignee: { name: "Ada", email: "ADA@example.test" },
				project: "Roadmap",
				createdAt: Date.UTC(2024, 0, 1),
				dueDate: "2024-02-30",
				estimate: 2.5,
			}),
		],
	};

	it("creates what is missing, matches what is there, and keeps the source's order", async () => {
		const plan = await planImport(github, target(), "t1");
		expect(plan.mutations.map((mutation) => mutation.name)).toEqual([
			"project.create",
			"issue.create",
			"label.create",
			"issue.create",
			"comment.create",
			"comment.create",
		]);
		expect(plan).toMatchObject({ issues: 2, comments: 2, skipped: 0 });
		expect(plan.newLabels).toEqual(["Needs triage"]);
		expect(plan.newProjects).toEqual(["Roadmap"]);
		expect(argsOf(plan, "label.create")[0]).toMatchObject({ color: "#ededed" });

		const [epic, crash] = argsOf(plan, "issue.create");
		// The parent first, assigned by email in any case; an impossible date and a fraction dropped.
		expect(epic).toMatchObject({
			id: await importId("github:1#1"),
			teamId: "t1",
			title: "Epic",
			assigneeId: "u1",
			dueDate: null,
			estimate: null,
			createdAt: Date.UTC(2024, 0, 1),
		});
		expect(crash).toMatchObject({
			title: "Crash on save",
			parentId: epic?.id,
			projectId: "p1",
			labelIds: ["l1", argsOf(plan, "label.create")[0]?.id],
			assigneeId: null,
		});
		expect(crash?.description).toBe(
			"It crashes.\n\n_Imported from [acme/api#2](https://github.com/acme/api/issues/2). Assigned in GitHub to octocat._",
		);
		expect(crash && epic && crash.sortOrder > epic.sortOrder).toBe(true);

		const comments = argsOf(plan, "comment.create");
		expect(comments.map((comment) => comment.body)).toEqual([
			"First",
			"_octocat wrote in GitHub:_\n\nSecond",
		]);
		expect(comments.every((comment) => comment.issueId === crash?.id)).toBe(true);
		expect(comments[0]?.createdAt).toBe(Date.UTC(2024, 0, 3));
	});

	it("skips what an earlier run imported, and brings in what is new", async () => {
		const first = await planImport(github, target(), "t1");
		const [epic, crash] = argsOf(first, "issue.create");
		const [comment] = argsOf(first, "comment.create");
		const existing = [epic, crash].map(
			(args) => ({ ...args, number: 1, version: 1 }) as unknown as Issue,
		);
		const again = await planImport(
			github,
			target(existing, [{ ...comment, authorId: "u1", updatedAt: 1 } as unknown as Comment]),
			"t1",
		);
		expect(again).toMatchObject({ issues: 0, comments: 1, skipped: 3 });
		expect(again.mutations.map((mutation) => mutation.name)).toEqual(["comment.create"]);
	});

	it("gives the same source item the same id", async () => {
		expect(await importId("github:1#2")).toBe(await importId("github:1#2"));
		expect(await importId("github:1#2")).not.toBe(await importId("github:1#3"));
		expect(await importId("x")).toMatch(/^import-[0-9a-f]{32}$/);
	});
});

describe("runImport", () => {
	it("keeps a window of mutations waiting, and reports refusals", async () => {
		const mutations: MutationInput[] = Array.from({ length: 25 }, (_, index) => ({
			name: "label.create",
			args: { id: `l${index}`, name: `Label ${index}`, color: "#e5484d" },
		}));
		let waiting = 0;
		let most = 0;
		const progress: number[] = [];
		const result = await runImport(
			async (mutation) => {
				waiting++;
				most = Math.max(most, waiting);
				await new Promise((resolve) => setTimeout(resolve, 1));
				waiting--;
				if (mutation.name === "label.create" && mutation.args.id === "l3") {
					throw new Error('A label named "Label 3" already exists');
				}
				return 1;
			},
			mutations,
			(update) => progress.push(update.done),
			undefined,
			5,
		);
		expect(most).toBeLessThanOrEqual(5);
		expect(result.done).toBe(25);
		expect(result.failed.map((failure) => failure.message)).toEqual([
			'A label named "Label 3" already exists',
		]);
		expect(progress.at(-1)).toBe(25);
	});

	it("stops sending when asked to", async () => {
		const controller = new AbortController();
		const sent: string[] = [];
		const mutations: MutationInput[] = ["a", "b", "c"].map((id) => ({
			name: "label.create",
			args: { id, name: id, color: "#e5484d" },
		}));
		await runImport(
			async (mutation) => {
				if (mutation.name === "label.create") sent.push(mutation.args.id);
				controller.abort();
				return 1;
			},
			mutations,
			() => {},
			controller.signal,
		);
		expect(sent).toEqual(["a"]);
	});
});
