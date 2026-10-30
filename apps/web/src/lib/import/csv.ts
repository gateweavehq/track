import type { IssuePriority, IssueStatus } from "@gateweave/track-protocol";
import type { ImportedIssue, ImportSource } from "./plan";

// Issues from a CSV file: Track's own export, read back by its headers, or a spreadsheet from
// elsewhere whose columns go by common names. One row is one issue; there are no comments.

/** Rows of an RFC 4180 file: quoted fields may hold commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const input = text.startsWith("﻿") ? text.slice(1) : text;
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (quoted) {
			if (char !== '"') field += char;
			else if (input[i + 1] === '"') {
				field += '"';
				i++;
			} else quoted = false;
		} else if (char === '"' && field === "") quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && input[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += char;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

type Column =
	| "key"
	| "title"
	| "description"
	| "status"
	| "priority"
	| "assignee"
	| "project"
	| "parent"
	| "labels"
	| "startDate"
	| "dueDate"
	| "estimate"
	| "created";

/** Headers by the names trackers and spreadsheets give them, Track's own first. */
const HEADERS: Record<Column, string[]> = {
	key: ["key", "issue key", "id", "issue id", "identifier", "number", "#"],
	title: ["title", "summary", "name", "subject", "issue"],
	description: ["description", "body", "details", "content"],
	status: ["status", "state", "column"],
	priority: ["priority"],
	assignee: ["assignee", "assigned to", "owner", "assignee email"],
	project: ["project", "epic", "milestone"],
	parent: ["parent", "parent issue", "parent key", "parent id"],
	labels: ["labels", "label", "tags"],
	startDate: ["start date", "start", "started"],
	dueDate: ["due date", "due", "target date", "deadline"],
	estimate: ["estimate", "points", "story points", "size"],
	created: ["created", "created at", "created date", "date created"],
};

export interface CsvImport {
	source: ImportSource;
	/** Columns the file has that nothing reads, so people know what was left out. */
	ignored: string[];
}

/**
 * Reads a CSV file into issues. Throws, with a message for the person importing, when the file
 * has no title column or no rows. `knownLabels` are the workspace's label names: a list of labels
 * is split at commas, except where the parts make up one of them.
 */
export function readCsvImport(text: string, knownLabels: readonly string[] = []): CsvImport {
	const known = new Set(knownLabels.map((name) => name.toLowerCase()));
	const [header, ...rows] = parseCsv(text);
	if (!header) throw new Error("The file is empty.");
	const names = header.map((name) => name.trim().toLowerCase());
	const index = {} as Record<Column, number>;
	for (const [column, aliases] of Object.entries(HEADERS) as [Column, string[]][]) {
		index[column] = aliases.map((alias) => names.indexOf(alias)).find((at) => at >= 0) ?? -1;
	}
	if (index.title < 0) {
		throw new Error('The file needs a column of titles, named "Title", "Summary" or "Name".');
	}
	if (rows.length === 0) throw new Error("The file has a header but no issues.");
	const used = new Set(Object.values(index));
	const ignored = header.filter((name, at) => !used.has(at) && name.trim());

	const cell = (row: string[], column: Column) => {
		const at = index[column];
		return at < 0 ? "" : unguard(row[at] ?? "").trim();
	};
	const issues: ImportedIssue[] = [];
	const keys = new Map<string, string>();
	rows.forEach((row, rowIndex) => {
		const title = cell(row, "title");
		if (!title) return;
		const key = cell(row, "key");
		const created = parseTime(cell(row, "created"));
		// The same row gets the same id each run, even when the file is edited around it.
		const sourceId = `csv:${key || title}:${created ?? (key ? "" : rowIndex)}`;
		if (key) keys.set(key.toLowerCase(), sourceId);
		issues.push({
			sourceId,
			title,
			description: cell(row, "description") || null,
			status: toStatus(cell(row, "status")),
			priority: toPriority(cell(row, "priority")),
			labels: splitLabels(cell(row, "labels"), known),
			assignee: cell(row, "assignee") || null,
			project: cell(row, "project") || null,
			parentSourceId: cell(row, "parent") || null,
			startDate: toDay(cell(row, "startDate")),
			dueDate: toDay(cell(row, "dueDate")),
			estimate: toEstimate(cell(row, "estimate")),
			createdAt: created,
			url: null,
			reference: key || null,
			comments: [],
		});
	});
	// Parents are named by key; within the file, a key leads to the row's issue.
	for (const issue of issues) {
		if (issue.parentSourceId) {
			issue.parentSourceId = keys.get(issue.parentSourceId.toLowerCase()) ?? null;
		}
	}
	return { source: { name: "CSV", issues }, ignored };
}

/** Track's export puts a quote before text a spreadsheet would run as a formula. */
function unguard(value: string): string {
	return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** Labels joined with ", ", as Track exports them. A known name with a comma stays whole. */
function splitLabels(value: string, known: ReadonlySet<string>): string[] {
	const parts = value.split(",").map((part) => part.trim());
	const labels: string[] = [];
	for (let start = 0; start < parts.length; start++) {
		let end = start;
		for (let candidate = parts.length - 1; candidate > start; candidate--) {
			if (
				known.has(
					parts
						.slice(start, candidate + 1)
						.join(", ")
						.toLowerCase(),
				)
			) {
				end = candidate;
				break;
			}
		}
		const label = parts.slice(start, end + 1).join(", ");
		if (label) labels.push(label);
		start = end;
	}
	return labels;
}

const STATUSES: Record<string, IssueStatus> = {
	backlog: "backlog",
	triage: "backlog",
	icebox: "backlog",
	todo: "todo",
	"to do": "todo",
	open: "todo",
	new: "todo",
	unstarted: "todo",
	"in progress": "in_progress",
	started: "in_progress",
	doing: "in_progress",
	active: "in_progress",
	"in review": "in_review",
	review: "in_review",
	"code review": "in_review",
	done: "done",
	closed: "done",
	completed: "done",
	complete: "done",
	resolved: "done",
	fixed: "done",
	canceled: "canceled",
	cancelled: "canceled",
	"won't do": "canceled",
	"won't fix": "canceled",
	wontfix: "canceled",
	duplicate: "canceled",
	"not planned": "canceled",
};

/** A status by the names trackers use. Unknown ones go to the backlog. */
export function toStatus(value: string): IssueStatus {
	return STATUSES[value.trim().toLowerCase().replace(/[_-]+/g, " ")] ?? "backlog";
}

const PRIORITIES: Record<string, IssuePriority> = {
	urgent: 1,
	critical: 1,
	blocker: 1,
	highest: 1,
	p0: 1,
	high: 2,
	p1: 2,
	medium: 3,
	normal: 3,
	p2: 3,
	low: 4,
	lowest: 4,
	minor: 4,
	trivial: 4,
	p3: 4,
	p4: 4,
};

/** A priority by the names trackers use. Unknown ones are "no priority". */
export function toPriority(value: string): IssuePriority {
	return PRIORITIES[value.trim().toLowerCase()] ?? 0;
}

/** `YYYY-MM-DD`, from a date or the date part of a timestamp. */
function toDay(value: string): string | null {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	return match?.[1] ?? null;
}

function toEstimate(value: string): number | null {
	if (!/^\d+$/.test(value)) return null;
	const points = Number(value);
	return points <= 1000 ? points : null;
}

function parseTime(value: string): number | null {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) || time < Date.UTC(2000, 0, 1) ? null : time;
}
