import {
	defaultStatuses,
	type Issue,
	type Label,
	type Member,
	type Team,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { type ExportSource, issuesToCsv } from "../export";
import { parseCsv, readCsvImport, toPriority, toStatus } from "./csv";

describe("parseCsv", () => {
	it("reads quoted fields with commas, quotes and line breaks", () => {
		expect(parseCsv('﻿a,b,c\r\n"1, one","say ""hi""","two\nlines"\r\n')).toEqual([
			["a", "b", "c"],
			["1, one", 'say "hi"', "two\nlines"],
		]);
	});

	it("takes LF or CRLF, a last row without a line break, and skips blank rows", () => {
		expect(parseCsv("a,b\n\n1,2\r\n3,")).toEqual([
			["a", "b"],
			["1", "2"],
			["3", ""],
		]);
	});
});

describe("readCsvImport", () => {
	it("reads columns by the names other trackers give them", () => {
		const { source, ignored } = readCsvImport(
			"Summary,State,Priority,Tags,Story Points,Due,Assigned To,Sprint\n" +
				"Fix login,In Progress,High,auth; bug,5,2026-11-20T00:00:00Z,ada@example.test,S12\n",
		);
		expect(ignored).toEqual(["Sprint"]);
		expect(source.issues).toMatchObject([
			{
				title: "Fix login",
				status: { name: "In Progress", category: "started" },
				priority: 2,
				labels: ["auth; bug"],
				estimate: 5,
				dueDate: "2026-11-20",
				assignee: { name: "ada@example.test", email: "ada@example.test" },
			},
		]);
	});

	it("leaves the text of a file that is not Jira's as it is", () => {
		const { source } = readCsvImport('Title,Description\nFix it,"h2. Not a heading, *not bold*"\n');
		expect(source.name).toBe("CSV");
		expect(source.issues[0]?.description).toBe("h2. Not a heading, *not bold*");
	});

	it("explains a file it cannot read", () => {
		expect(() => readCsvImport("")).toThrow("empty");
		expect(() => readCsvImport("Key,Status\nENG-1,Done\n")).toThrow("column of titles");
		expect(() => readCsvImport("Title\n")).toThrow("no issues");
	});

	it("gives a row the same source id every time", () => {
		const csv = "Key,Title,Created\nENG-1,First,2026-01-02T03:04:05Z\nENG-2,Second,\n,Third,\n";
		const first = readCsvImport(csv).source.issues.map((issue) => issue.sourceId);
		const edited = readCsvImport(csv.replace("First", "First renamed")).source.issues;
		expect(edited.map((issue) => issue.sourceId)).toEqual(first);
		expect(new Set(first).size).toBe(3);
	});
});

describe("statuses and priorities", () => {
	it("maps the names trackers use", () => {
		expect(
			["Backlog", "To Do", "open", "IN_PROGRESS", "Review", "Closed", "Won't Fix", "?"].map(
				toStatus,
			),
		).toEqual([
			{ name: "Backlog", category: "backlog" },
			{ name: "To Do", category: "unstarted" },
			{ name: "open", category: "unstarted" },
			{ name: "IN_PROGRESS", category: "started" },
			{ name: "Review", category: "started" },
			{ name: "Closed", category: "completed" },
			{ name: "Won't Fix", category: "canceled" },
			{ name: "?", category: "backlog" },
		]);
		expect(["Urgent", "P1", "Medium", "low", "No priority", ""].map(toPriority)).toEqual([
			1, 2, 3, 4, 0, 0,
		]);
	});
});

describe("a Track export read back", () => {
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
	const ada: Member = {
		id: "u1",
		name: "Ada",
		email: "ada@example.test",
		image: null,
		role: "owner",
		proposes: [],
		removedAt: null,
	};
	const labels: Label[] = [
		{ id: "l1", name: "Bug", color: "#e5484d", createdAt: 1, updatedAt: 1 },
		{ id: "l2", name: "UI, web", color: "#0090ff", createdAt: 1, updatedAt: 1 },
	];
	const created = Date.UTC(2026, 0, 2, 3, 4, 5);
	const base: Omit<Issue, "id" | "number" | "title"> = {
		teamId: "t1",
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
		createdAt: created,
		updatedAt: created,
		archivedAt: null,
		intake: false,
	};
	const issues: Issue[] = [
		{
			...base,
			id: "i1",
			number: 1,
			title: "=SUM(A1:A2) looks like a formula",
			description: "Line one\nLine, two",
			status: "in_review",
			priority: 1,
			assigneeId: "u1",
			labelIds: ["l1", "l2"],
			dueDate: "2026-11-20",
			estimate: 3,
		},
		{ ...base, id: "i2", number: 2, title: "Child", parentId: "i1", createdAt: created + 1000 },
	];
	const source: ExportSource = {
		workspace: { slug: "acme", name: "Acme" },
		teams: [eng],
		statuses: defaultStatuses("t1", 1),
		members: [ada],
		labels,
		projects: [],
		issues,
		comments: [],
		activities: [],
		relations: [],
		cycles: [],
	};

	it("keeps what the export wrote", () => {
		const csv = issuesToCsv(source);
		const read = readCsvImport(csv, ["Bug", "UI, web"]).source.issues;
		expect(read).toMatchObject([
			{
				title: "=SUM(A1:A2) looks like a formula",
				description: "Line one\nLine, two",
				status: { name: "In Review", category: "started" },
				priority: 1,
				assignee: { email: "ada@example.test" },
				labels: ["Bug", "UI, web"],
				dueDate: "2026-11-20",
				estimate: 3,
				createdAt: created,
				reference: "ENG-1",
				parentSourceId: null,
			},
			{ title: "Child", createdAt: created + 1000 },
		]);
		expect(read[1]?.parentSourceId).toBe(read[0]?.sourceId);
		// Without the workspace's labels, a name with a comma splits.
		expect(readCsvImport(csv).source.issues[0]?.labels).toEqual(["Bug", "UI", "web"]);
	});
});

describe("a Jira CSV export", () => {
	// The shape Jira Cloud's "Export Excel CSV (all fields)" writes: repeated columns, its own
	// dates, account ids next to names, and parents by numeric issue id.
	const header = [
		"Summary",
		"Issue key",
		"Issue id",
		"Issue Type",
		"Status",
		"Status Category",
		"Priority",
		"Assignee",
		"Assignee Id",
		"Reporter",
		"Reporter Id",
		"Created",
		"Due date",
		"Labels",
		"Labels",
		"Sprint",
		"Sprint",
		"Description",
		"Custom field (Story Points)",
		"Parent",
		"Comment",
		"Comment",
	];
	const csv = [
		header.join(","),
		[
			"Checkout fails on Safari",
			"SHOP-12",
			"10042",
			"Bug",
			"QA Ready",
			"In Progress",
			"Highest",
			"Ada Lovelace",
			"712020:aaaa1111-2222-3333-4444-555566667777",
			"Grace Hopper",
			"5b10ac8d82e05b22cc7d4ef5",
			"02/Nov/26 2:27 PM",
			"20/Nov/26",
			"checkout",
			"safari",
			"Sprint 4",
			"Sprint 5",
			'"Steps:\n# open the cart\n# pay"',
			"3.0",
			"10040",
			'"03/Nov/26 9:05 AM;5b10ac8d82e05b22cc7d4ef5;Seen on *iOS 18*; not on macOS."',
			'"04/Nov/26 11:30 PM;712020:ffff0000-1111-2222-3333-444455556666;Fixed in the next build."',
		].join(","),
		[
			"Payments epic",
			"SHOP-10",
			"10040",
			"Epic",
			"Done",
			"Done",
			"Medium",
			"",
			"",
			"Grace Hopper",
			"5b10ac8d82e05b22cc7d4ef5",
			"01/Oct/2026 10:00 AM",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
		].join(","),
		[
			"Plain task",
			"SHOP-13",
			"10043",
			"Task",
			"Ready for QA",
			"To Do",
			"Low",
			"",
			"",
			"",
			"",
			"02/Nov/26 12:15 AM",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"",
			"just a note",
			"",
		].join(","),
	].join("\n");

	it("reads every label and comment, its dates, story points and parents", () => {
		const { source, ignored } = readCsvImport(csv);
		expect(source.name).toBe("Jira");
		expect(ignored).toEqual(["Sprint"]);
		const [bug, epic, task] = source.issues;
		expect(bug).toMatchObject({
			title: "Checkout fails on Safari",
			reference: "SHOP-12",
			// Jira's markup turns into Markdown.
			description: "Steps:\n1. open the cart\n1. pay",
			// A status of the team's own naming means what its category says.
			status: { name: "QA Ready", category: "started" },
			priority: 1,
			assignee: { name: "Ada Lovelace" },
			labels: ["checkout", "safari", "Bug"],
			createdAt: Date.UTC(2026, 10, 2, 14, 27),
			dueDate: "2026-11-20",
			estimate: 3,
			parentSourceId: epic?.sourceId,
			comments: [
				{
					body: "Seen on **iOS 18**; not on macOS.",
					author: "Grace Hopper",
					createdAt: Date.UTC(2026, 10, 3, 9, 5),
				},
				// An account id nobody in the file has is left out rather than shown.
				{
					body: "Fixed in the next build.",
					author: null,
					createdAt: Date.UTC(2026, 10, 4, 23, 30),
				},
			],
		});
		expect(epic).toMatchObject({
			status: { name: "Done", category: "completed" },
			labels: ["Epic"],
			createdAt: Date.UTC(2026, 9, 1, 10),
			parentSourceId: null,
		});
		expect(task).toMatchObject({
			status: { category: "unstarted" },
			labels: [],
			createdAt: Date.UTC(2026, 10, 2, 0, 15),
			comments: [{ body: "just a note", author: null, createdAt: null }],
		});
		const ids = source.issues.flatMap((issue) => issue.comments.map((comment) => comment.sourceId));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("gives comments the same source ids every run", () => {
		const ids = (text: string) =>
			readCsvImport(text).source.issues.flatMap((issue) => issue.comments.map((c) => c.sourceId));
		expect(ids(csv.replace("Plain task", "Plain task renamed"))).toEqual(ids(csv));
	});
});
