import type {
	Comment,
	Issue,
	IssueRelation,
	Label,
	Member,
	MutationInput,
	Project,
	Team,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { type ExportSource, workspaceToJson } from "#/lib/export";
import { readJsonImport } from "./json";
import { type ImportTarget, importId, planImport } from "./plan";

// The JSON export, read back into another workspace: what one Track writes, another takes in.

const eng: Team = {
	id: "t1",
	key: "ENG",
	name: "Engineering",
	cycles: null,
	createdAt: 1,
	updatedAt: 1,
};
const ops: Team = {
	id: "t2",
	key: "OPS",
	name: "Operations",
	cycles: null,
	createdAt: 1,
	updatedAt: 1,
};
const ada: Member = {
	id: "u1",
	name: "Ada",
	email: "ada@example.test",
	image: null,
	role: "owner",
	proposes: [],
	removedAt: null,
};
const grace: Member = { ...ada, id: "u2", name: "Grace", email: "grace@example.test" };
const bug: Label = { id: "l1", name: "Bug", color: "#e5484d", createdAt: 1, updatedAt: 1 };
const launch: Project = {
	id: "p1",
	name: "Launch",
	description: "Ship it",
	status: "started",
	leadId: "u2",
	targetDate: "2026-12-01",
	createdAt: 1,
	updatedAt: 1,
};

function issue(overrides: Partial<Issue> & Pick<Issue, "id" | "teamId" | "number">): Issue {
	return {
		title: "Title",
		description: null,
		status: "backlog",
		priority: 0,
		assigneeId: null,
		creatorId: "u1",
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		labelIds: [],
		sortOrder: "a0",
		version: 1,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

const epicIssue = issue({ id: "i1", teamId: "t1", number: 1, title: "Epic", createdAt: 10 });
const outageIssue = issue({
	id: "i2",
	teamId: "t2",
	number: 4,
	title: "Fix the outage",
	status: "in_progress",
	priority: 1,
	assigneeId: "u2",
	projectId: "p1",
	parentId: "i1",
	dueDate: "2026-11-20",
	estimate: 3,
	labelIds: ["l1"],
	createdAt: 20,
});
const reply: Comment = {
	id: "c1",
	issueId: "i2",
	authorId: "u2",
	body: "On it.",
	createdAt: 30,
	updatedAt: 30,
};
const blocks: IssueRelation = {
	id: "r1",
	type: "blocks",
	issueId: "i2",
	relatedIssueId: "i1",
	creatorId: "u1",
	createdAt: 40,
};
const exported: ExportSource = {
	workspace: { slug: "acme", name: "Acme" },
	teams: [eng, ops],
	members: [ada, grace],
	labels: [bug],
	projects: [launch],
	issues: [epicIssue, outageIssue],
	comments: [reply],
	activities: [],
	relations: [blocks],
	cycles: [],
};

/** Another workspace: it has Engineering (as ENG) and Grace, and nothing else of Acme's. */
function elsewhere(overrides: Partial<ImportTarget> = {}): ImportTarget {
	return {
		issues: new Map(),
		comments: new Map(),
		relations: new Map(),
		teams: [{ ...eng, id: "home-eng", name: "Core" }],
		labels: [],
		projects: [],
		members: [{ ...grace, id: "home-grace" }],
		...overrides,
	};
}

type ArgsOf<N extends MutationInput["name"]> = Extract<MutationInput, { name: N }>["args"];

function argsOf<N extends MutationInput["name"]>(mutations: MutationInput[], name: N) {
	return mutations
		.filter((mutation) => mutation.name === name)
		.map((mutation) => mutation.args as ArgsOf<N>);
}

describe("readJsonImport", () => {
	it("brings issues back with their comments, relations, labels, project and parent", async () => {
		const { source } = readJsonImport(workspaceToJson(exported));
		expect(source.name).toBe("Acme");
		const plan = await planImport(source, elsewhere(), "home-eng");
		expect(plan).toMatchObject({ issues: 2, comments: 1, relations: 1, skipped: 0 });
		expect(plan.newLabels).toEqual(["Bug"]);
		expect(plan.newProjects).toEqual(["Launch"]);
		expect(plan.newTeams).toEqual([]);

		const [label] = argsOf(plan.mutations, "label.create");
		expect(label?.color).toBe("#e5484d");
		const [project] = argsOf(plan.mutations, "project.create");
		expect(project).toMatchObject({
			description: "Ship it",
			status: "started",
			leadId: "home-grace",
			targetDate: "2026-12-01",
		});

		const [epic, outage] = argsOf(plan.mutations, "issue.create");
		expect(epic).toMatchObject({ title: "Epic", teamId: "home-eng", createdAt: 10 });
		expect(outage).toMatchObject({
			title: "Fix the outage",
			teamId: "home-eng",
			status: "in_progress",
			priority: 1,
			assigneeId: "home-grace",
			projectId: project?.id,
			parentId: epic?.id,
			dueDate: "2026-11-20",
			estimate: 3,
			labelIds: [label?.id],
			createdAt: 20,
		});
		const [comment] = argsOf(plan.mutations, "comment.create");
		expect(comment).toMatchObject({
			issueId: outage?.id,
			body: "_Grace wrote in Acme:_\n\nOn it.",
			createdAt: 30,
		});
		const [relation] = argsOf(plan.mutations, "relation.create");
		expect(relation).toEqual({
			id: await importId("track:r1"),
			type: "blocks",
			issueId: outage?.id,
			relatedIssueId: epic?.id,
		});
		// Relations come last, once both of their issues exist.
		expect(plan.mutations.at(-1)?.name).toBe("relation.create");
	});

	it("keeps the file's teams when asked: matched by key, else created", async () => {
		const { source } = readJsonImport(workspaceToJson(exported));
		const plan = await planImport(source, elsewhere(), "home-eng", { keepTeams: true });
		const [team] = argsOf(plan.mutations, "team.create");
		expect(team).toMatchObject({ key: "OPS", name: "Operations" });
		expect(plan.newTeams).toEqual(["Operations (OPS)"]);
		const [epic, outage] = argsOf(plan.mutations, "issue.create");
		expect(epic?.teamId).toBe("home-eng");
		expect(outage?.teamId).toBe(team?.id);
		const names = plan.mutations.map((mutation) => mutation.name);
		expect(names.indexOf("team.create")).toBeLessThan(names.lastIndexOf("issue.create"));
	});

	it("skips everything a second time", async () => {
		const { source } = readJsonImport(workspaceToJson(exported));
		const first = await planImport(source, elsewhere(), "home-eng");
		const ids = (name: "issue.create" | "comment.create" | "relation.create") =>
			argsOf(first.mutations, name).map((args) => args.id);
		const done = elsewhere({
			issues: new Map(ids("issue.create").map((id) => [id, issue({ id, teamId: "t", number: 1 })])),
			comments: new Map(ids("comment.create").map((id) => [id, { ...reply, id }])),
			relations: new Map(ids("relation.create").map((id) => [id, { ...blocks, id }])),
		});
		const again = await planImport(source, done, "home-eng");
		expect(again.mutations).toEqual([]);
		expect(again).toMatchObject({ issues: 0, comments: 0, relations: 0, skipped: 4 });
	});

	it("reads an export from before relations, and leaves out what points outside the file", () => {
		const doc = JSON.parse(workspaceToJson({ ...exported, issues: [outageIssue], relations: [] }));
		delete doc.relations;
		const { source } = readJsonImport(JSON.stringify(doc));
		expect(source.relations).toEqual([]);
		expect(source.issues[0]).toMatchObject({ parentSourceId: null, reference: "OPS-4" });
	});

	it("says what is wrong with a file that is not an export", () => {
		expect(() => readJsonImport("{")).toThrow("not valid JSON");
		expect(() => readJsonImport('{"issues": []}')).toThrow("not a Gateweave Track export");
		expect(() =>
			readJsonImport(JSON.stringify({ format: "gateweave-track-export", version: 99 })),
		).toThrow("newer version");
		expect(() =>
			readJsonImport(JSON.stringify({ format: "gateweave-track-export", version: 1, teams: 3 })),
		).toThrow("teams is not as Track writes it");
	});

	it("notes that history stays behind", () => {
		const { notes } = readJsonImport(
			workspaceToJson({
				...exported,
				activities: [
					{
						id: "a1",
						issueId: "i1",
						actorId: "u1",
						change: { type: "status", from: "backlog", to: "done" },
						proposedBy: null,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
		);
		expect(notes).toEqual([expect.stringContaining("history stays behind")]);
	});
});
