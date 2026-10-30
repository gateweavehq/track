import type { Issue, Label, Member, Team } from "@gateweave/track-protocol";
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
				status: "in_progress",
				priority: 2,
				labels: ["auth; bug"],
				estimate: 5,
				dueDate: "2026-11-20",
				assignee: { name: "ada@example.test", email: "ada@example.test" },
			},
		]);
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
			"backlog",
			"todo",
			"todo",
			"in_progress",
			"in_review",
			"done",
			"canceled",
			"backlog",
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
		members: [ada],
		labels,
		projects: [],
		issues,
		comments: [],
		activities: [],
		relations: [],
	};

	it("keeps what the export wrote", () => {
		const csv = issuesToCsv(source);
		const read = readCsvImport(csv, ["Bug", "UI, web"]).source.issues;
		expect(read).toMatchObject([
			{
				title: "=SUM(A1:A2) looks like a formula",
				description: "Line one\nLine, two",
				status: "in_review",
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
