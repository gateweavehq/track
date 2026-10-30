import type {
	Activity,
	Comment,
	Issue,
	Label,
	Member,
	Project,
	Team,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import {
	CSV_COLUMNS,
	type ExportSource,
	exportFileName,
	issuesToCsv,
	workspaceToJson,
} from "./export";

const eng: Team = { id: "t1", key: "ENG", name: "Engineering", createdAt: 1, updatedAt: 1 };
const ops: Team = { id: "t2", key: "OPS", name: "Operations", createdAt: 1, updatedAt: 1 };

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
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		labelIds: [],
		sortOrder: "a0",
		version: 1,
		createdAt: CREATED,
		updatedAt: CREATED + 1000,
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
		createdAt: 1,
		updatedAt: 1,
	};
}

function source(issues: Issue[], extra: Partial<ExportSource> = {}): ExportSource {
	return {
		workspace: { slug: "acme", name: "Acme" },
		teams: [ops, eng],
		members: [ada, bot],
		labels: [bug, ui],
		projects: [launch],
		issues,
		comments: [],
		activities: [],
		relations: [],
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
});

describe("workspaceToJson", () => {
	const issues = [
		issue({ id: "a", teamId: "t2", number: 1, title: "Ops issue" }),
		issue({ id: "b", teamId: "t1", number: 1, title: "Eng issue", labelIds: ["l1"] }),
	];
	const full = source(issues, {
		comments: [comment("c1", "a"), comment("c2", "b")],
		activities: [activity("x1", "a"), activity("x2", "b")],
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
		expect(doc.members).toEqual([
			{ id: "u1", name: "Ada", email: "ada@example.test", role: "owner" },
			{ id: "u2", name: "Bot", email: "bot@example.test", role: "agent" },
		]);
		expect(doc.labels).toHaveLength(2);
		expect(doc.projects).toHaveLength(1);
		expect(doc.issues.map((item: { key: string }) => item.key)).toEqual(["ENG-1", "OPS-1"]);
		expect(doc.issues[0]).toMatchObject({ id: "b", labelIds: ["l1"], status: "backlog" });
		expect(doc.comments).toHaveLength(2);
		expect(doc.activities).toHaveLength(2);
		expect(doc.relations).toMatchObject([{ id: "r1", type: "blocks" }]);
		expect(doc).not.toHaveProperty("proposals");
	});

	it("keeps every team, member, label and project but only one team's issues and their rows", () => {
		const doc = JSON.parse(workspaceToJson(full, "t1"));
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
});

describe("exportFileName", () => {
	it("names the workspace, the team if any, and the day", () => {
		expect(exportFileName("acme", null, "2026-10-30", "csv")).toBe("acme-2026-10-30.csv");
		expect(exportFileName("acme", "ENG", "2026-10-30", "json")).toBe("acme-eng-2026-10-30.json");
	});
});
