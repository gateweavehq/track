import {
	type Activity,
	type Comment,
	type Cycle,
	defaultStatuses,
	type Issue,
	type Label,
	type Member,
	type Project,
	type Team,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	ARCHIVED_EXPORT_NOTE,
	archivedInExport,
	CSV_COLUMNS,
	type ExportSource,
	exportFileName,
	issuesToCsv,
	workspaceToJson,
} from "./export";

const eng: Team = {
	id: "t1",
	key: "ENG",
	name: "Engineering",
	cycles: null,
	archiveAfterMonths: null,
	closeAfterMonths: null,
	intakeFormKey: null,
	intakeEmailKey: null,
	createdAt: 1,
	updatedAt: 1,
};
const ops: Team = {
	id: "t2",
	key: "OPS",
	name: "Operations",
	cycles: null,
	archiveAfterMonths: null,
	closeAfterMonths: null,
	intakeFormKey: null,
	intakeEmailKey: null,
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
const bot: Member = { ...ada, id: "u2", name: "Bot", email: "bot@example.test", role: "agent" };

const bug: Label = { id: "l1", name: "Bug", color: "#ff0000", createdAt: 1, updatedAt: 1 };
const ui: Label = { id: "l2", name: "UI, web", color: "#00ff00", createdAt: 1, updatedAt: 1 };

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

const CREATED = Date.UTC(2026, 9, 30, 12, 30, 0);

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
		createdAt: CREATED,
		updatedAt: CREATED + 1000,
		archivedAt: null,
		intake: false,
		...overrides,
	};
}

function comment(id: string, issueId: string): Comment {
	return { id, issueId, authorId: "u1", body: `Comment ${id}`, createdAt: 1, updatedAt: 1 };
}

function activity(id: string, issueId: string): Activity {
	return {
		id,
		issueId,
		actorId: "u1",
		change: { type: "status", from: "backlog", to: "done" },
		proposedBy: null,
		source: null,
		createdAt: 1,
		updatedAt: 1,
	};
}

function cycle(id: string, teamId: string): Cycle {
	return {
		id,
		teamId,
		number: 1,
		name: null,
		startsOn: "2026-11-02",
		endsOn: "2026-11-15",
		completedAt: null,
		createdAt: 1,
		updatedAt: 1,
	};
}

function source(issues: Issue[], extra: Partial<ExportSource> = {}): ExportSource {
	return {
		workspace: { slug: "acme", name: "Acme" },
		teams: [ops, eng],
		statuses: [...defaultStatuses("t2", 1), ...defaultStatuses("t1", 1)],
		members: [ada, bot],
		labels: [bug, ui],
		projects: [launch],
		issues,
		comments: [],
		activities: [],
		relations: [],
		cycles: [],
		...extra,
	};
}

/** The CSV without its byte order mark, split into rows and cells (no quoting in these). */
function rows(csv: string): string[][] {
	return csv
		.replace(/^﻿/, "")
		.split("\r\n")
		.filter(Boolean)
		.map((row) => row.split(","));
}

describe("issuesToCsv", () => {
	it("starts with a byte order mark and the headers, and ends rows with CRLF", () => {
		const csv = issuesToCsv(source([issue({ id: "i1", teamId: "t1", number: 1 })]));
		expect(csv.startsWith("﻿")).toBe(true);
		expect(csv.slice(1).split("\r\n")[0]).toBe(
			"Key,Title,Description,Team,Status,Priority,Assignee,Creator,Project,Parent,Labels,Start date,Due date,Estimate,Created,Updated",
		);
		expect(csv.endsWith("\r\n")).toBe(true);
		expect(csv).not.toMatch(/[^\r]\n/);
		expect(CSV_COLUMNS).toHaveLength(16);
	});

	it("writes words for status and priority, emails for people, names for project and labels", () => {
		const csv = issuesToCsv(
			source([
				issue({
					id: "i1",
					teamId: "t1",
					number: 7,
					title: "Fix login",
					status: "in_progress",
					priority: 2,
					assigneeId: "u2",
					creatorId: "u1",
					projectId: "p1",
					cycleId: null,
					parentId: "i0",
					labelIds: ["l1", "l2"],
					startDate: "2026-11-01",
					dueDate: "2026-11-15",
					estimate: 5,
				}),
				// The parent is in another team, and still has its key.
				issue({ id: "i0", teamId: "t2", number: 3 }),
			]),
		);
		expect(csv.replace(/^﻿/, "").split("\r\n")[1]).toBe(
			'ENG-7,Fix login,,Engineering,In Progress,High,bot@example.test,ada@example.test,Launch,OPS-3,"Bug, UI, web",2026-11-01,2026-11-15,5,2026-10-30T12:30:00.000Z,2026-10-30T12:30:01.000Z',
		);
	});

	it("names an issue's status as its team does", () => {
		const qa: WorkflowStatus = {
			id: "t1/qa",
			teamId: "t1",
			key: "qa",
			name: "Ready for QA",
			category: "started",
			color: null,
			sortOrder: "a2",
			createdAt: 1,
			updatedAt: 1,
			removedAt: null,
		};
		const statuses = [...defaultStatuses("t1", 1), qa];
		const csv = issuesToCsv(
			source([issue({ id: "i1", teamId: "t1", number: 1, status: "qa" })], { statuses }),
		);
		expect(rows(csv)[1]?.[4]).toBe("Ready for QA");
	});

	it("leaves empty fields empty", () => {
		const csv = issuesToCsv(source([issue({ id: "i1", teamId: "t1", number: 1 })]));
		const row = rows(csv)[1];
		expect(row?.slice(2)).toEqual([
			"",
			"Engineering",
			"Backlog",
			"No priority",
			"",
			"ada@example.test",
			"",
			"",
			"",
			"",
			"",
			"",
			"2026-10-30T12:30:00.000Z",
			"2026-10-30T12:30:01.000Z",
		]);
	});

	it("quotes fields with a comma, a quote or a line break, and doubles quotes", () => {
		const csv = issuesToCsv(
			source([
				issue({
					id: "i1",
					teamId: "t1",
					number: 1,
					title: 'Say "hi", then leave',
					description: "line one\nline two\r\nline three",
				}),
			]),
		);
		expect(csv).toContain('"Say ""hi"", then leave"');
		expect(csv).toContain('"line one\nline two\r\nline three"');
	});

	it("prefixes cells that a spreadsheet would run as a formula", () => {
		const cells = ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"];
		const csv = issuesToCsv(
			source(
				cells.map((title, index) =>
					issue({ id: `i${index}`, teamId: "t1", number: index + 1, title }),
				),
			),
		);
		expect(csv).toContain(",'=1+1,");
		expect(csv).toContain(",'+1,");
		expect(csv).toContain(",'-1,");
		expect(csv).toContain(",'@SUM(A1),");
		expect(csv).toContain(",'\tx,");
		// A CR makes the field quoted as well.
		expect(csv).toContain(',"\'\rx",');
		// Text that merely contains such a character is left alone.
		const plain = issuesToCsv(
			source([issue({ id: "i1", teamId: "t1", number: 1, title: "a=b - c @d" })]),
		);
		expect(plain).toContain(",a=b - c @d,");
	});

	it("orders by team, then by issue number", () => {
		const csv = issuesToCsv(
			source([
				issue({ id: "a", teamId: "t2", number: 1 }),
				issue({ id: "b", teamId: "t1", number: 10 }),
				issue({ id: "c", teamId: "t1", number: 2 }),
			]),
		);
		expect(rows(csv).map((row) => row[0])).toEqual(["Key", "ENG-2", "ENG-10", "OPS-1"]);
	});

	it("exports only one team's issues when asked", () => {
		const csv = issuesToCsv(
			source([
				issue({ id: "a", teamId: "t2", number: 1 }),
				issue({ id: "b", teamId: "t1", number: 1 }),
			]),
			"t2",
		);
		expect(rows(csv).map((row) => row[0])).toEqual(["Key", "OPS-1"]);
	});

	it("has only the header for a workspace without issues", () => {
		expect(rows(issuesToCsv(source([])))).toHaveLength(1);
	});

	it("lists archived issues last, with only what the replica holds of them", () => {
		const csv = issuesToCsv(
			source([
				issue({
					id: "a",
					teamId: "t1",
					number: 1,
					title: "Old",
					status: "done",
					description: "Never in the replica",
					priority: 2,
					projectId: "p1",
					estimate: 3,
					archivedAt: CREATED,
				}),
				issue({ id: "b", teamId: "t1", number: 2, title: "New" }),
			]),
		);
		expect(rows(csv).slice(1)).toEqual([
			expect.arrayContaining(["ENG-2", "New"]),
			[
				"ENG-1",
				"Old",
				"",
				"Engineering",
				"Done",
				"",
				"",
				"",
				"Launch",
				"",
				"",
				"",
				"",
				"3",
				"",
				"",
			],
		]);
	});
});

describe("workspaceToJson", () => {
	const issues = [
		issue({ id: "a", teamId: "t2", number: 1, title: "Ops issue" }),
		issue({ id: "b", teamId: "t1", number: 1, title: "Eng issue", labelIds: ["l1"] }),
	];
	const full = source(issues, {
		comments: [comment("c1", "a"), comment("c2", "b")],
		activities: [activity("x1", "a"), activity("x2", "b")],
		cycles: [cycle("cy2", "t2"), cycle("cy1", "t1")],
		relations: [
			{
				id: "r1",
				type: "blocks",
				issueId: "a",
				relatedIssueId: "b",
				creatorId: "u1",
				createdAt: 1,
			},
		],
	});

	it("leaves out the secrets of a team's request form and intake address", () => {
		const shared = source(issues, {
			teams: [{ ...eng, intakeFormKey: "f".repeat(32), intakeEmailKey: "e".repeat(16) }, ops],
		});
		const text = workspaceToJson(shared);
		expect(text).not.toContain("f".repeat(32));
		expect(text).not.toContain("e".repeat(16));
		expect(JSON.parse(text).teams[0]).not.toHaveProperty("intakeFormKey");
		expect(JSON.parse(text).teams[0]).not.toHaveProperty("intakeEmailKey");
	});

	it("is a tab-indented document of the protocol's shapes", () => {
		const text = workspaceToJson(full, null, new Date("2026-10-30T13:00:00Z"));
		expect(text).toContain('\n\t"format": "gateweave-track-export"');
		const doc = JSON.parse(text);
		expect(doc).toMatchObject({
			format: "gateweave-track-export",
			version: 1,
			exportedAt: "2026-10-30T13:00:00.000Z",
			workspace: { slug: "acme", name: "Acme" },
		});
		expect(doc.teams.map((team: Team) => team.key)).toEqual(["ENG", "OPS"]);
		// By team, each in its workflow order.
		expect(doc.statuses.map((status: WorkflowStatus) => status.id)).toEqual([
			...defaultStatuses("t1", 1).map((status) => status.id),
			...defaultStatuses("t2", 1).map((status) => status.id),
		]);
		expect(doc.members).toEqual([
			{ id: "u1", name: "Ada", email: "ada@example.test", role: "owner" },
			{ id: "u2", name: "Bot", email: "bot@example.test", role: "agent" },
		]);
		expect(doc.labels).toHaveLength(2);
		expect(doc.projects).toHaveLength(1);
		// By team, like the issues.
		expect(doc.cycles.map((item: Cycle) => item.id)).toEqual(["cy1", "cy2"]);
		expect(doc.issues.map((item: { key: string }) => item.key)).toEqual(["ENG-1", "OPS-1"]);
		expect(doc.issues[0]).toMatchObject({ id: "b", labelIds: ["l1"], status: "backlog" });
		expect(doc.comments).toHaveLength(2);
		expect(doc.activities).toHaveLength(2);
		expect(doc.relations).toMatchObject([{ id: "r1", type: "blocks" }]);
		expect(doc).not.toHaveProperty("proposals");
	});

	it("keeps every team, member, label and project but only one team's issues and their rows", () => {
		const doc = JSON.parse(workspaceToJson(full, "t1"));
		expect(doc.cycles.map((item: Cycle) => item.id)).toEqual(["cy1"]);
		expect(doc.statuses.every((status: WorkflowStatus) => status.teamId === "t1")).toBe(true);
		expect(doc.teams).toHaveLength(2);
		expect(doc.members).toHaveLength(2);
		expect(doc.labels).toHaveLength(2);
		expect(doc.projects).toHaveLength(1);
		expect(doc.issues.map((item: Issue) => item.id)).toEqual(["b"]);
		expect(doc.comments.map((item: Comment) => item.id)).toEqual(["c2"]);
		expect(doc.activities.map((item: Activity) => item.id)).toEqual(["x2"]);
		// The relation reaches an issue of another team, which the file does not hold.
		expect(doc.relations).toEqual([]);
	});

	it("lists archived issues apart, slim, and says their details are not included", () => {
		const old = issue({
			id: "z",
			teamId: "t1",
			number: 7,
			title: "Old",
			status: "done",
			description: "Never in the replica",
			labelIds: ["l1"],
			archivedAt: CREATED,
		});
		const doc = JSON.parse(workspaceToJson(source([...issues, old])));
		expect(doc.issues.map((item: Issue) => item.id)).toEqual(["b", "a"]);
		expect(doc.archivedIssues).toEqual([
			{
				id: "z",
				key: "ENG-7",
				teamId: "t1",
				number: 7,
				title: "Old",
				status: "done",
				projectId: null,
				cycleId: null,
				parentId: null,
				estimate: null,
				archivedAt: CREATED,
			},
		]);
		expect(doc.notes).toEqual([ARCHIVED_EXPORT_NOTE]);
		expect(ARCHIVED_EXPORT_NOTE).toContain("not included yet");
		expect(archivedInExport(source([...issues, old]))).toBe(1);
		expect(archivedInExport(source([...issues, old]), "t2")).toBe(0);

		// Without archived issues there is nothing to say.
		expect(JSON.parse(workspaceToJson(full))).toMatchObject({ archivedIssues: [], notes: [] });
	});
});

describe("exportFileName", () => {
	it("names the workspace, the team if any, and the day", () => {
		expect(exportFileName("acme", null, "2026-10-30", "csv")).toBe("acme-2026-10-30.csv");
		expect(exportFileName("acme", "ENG", "2026-10-30", "json")).toBe("acme-eng-2026-10-30.json");
	});
});
