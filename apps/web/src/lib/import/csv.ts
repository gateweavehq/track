import type { IssuePriority, StatusCategory } from "@gateweave/track-protocol";
import type {
	ImportedComment,
	ImportedIssue,
	ImportedPerson,
	ImportedStatus,
	ImportSource,
} from "./plan";

// Issues from a CSV file: Track's own export, read back by its headers, or a spreadsheet from
// elsewhere whose columns go by common names. One row is one issue. Jira's CSV export, the only
// way out of Jira that a browser can read, repeats a column for each label and each comment,
// writes dates its own way and names parents by its numeric issue id; all of that is read too.

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
	| "created"
	| "issueId"
	| "statusCategory"
	| "type";

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
	estimate: [
		"estimate",
		"points",
		"story points",
		"size",
		"custom field (story points)",
		"custom field (story point estimate)",
	],
	created: ["created", "created at", "created date", "date created"],
	issueId: ["issue id"],
	statusCategory: ["status category"],
	type: ["issue type"],
};

/** Jira writes one comment in each of as many columns as an issue has comments. */
const COMMENTS = ["comment", "comments"];

/** Issue types that say nothing a label would add: every issue is one. */
const PLAIN_TYPES = new Set(["task", "sub-task", "subtask", "issue"]);

/** Jira's people columns, each with the column of their account ids, which comments name. */
const PEOPLE = [
	["assignee", "assignee id"],
	["reporter", "reporter id"],
	["creator", "creator id"],
] as const;

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
	// A repeated column is read in every copy of it, under the name its first copy has.
	const every = (column: Column) => {
		const at = index[column];
		return at < 0 ? [] : names.flatMap((name, i) => (name === names[at] ? [i] : []));
	};
	const labelColumns = every("labels");
	const commentColumns = names.flatMap((name, i) => (COMMENTS.includes(name) ? [i] : []));
	const peopleColumns = PEOPLE.flatMap(([name, id]) => {
		const pair = [names.indexOf(name), names.indexOf(id)] as const;
		return pair[0] >= 0 && pair[1] >= 0 ? [pair] : [];
	});
	const used = new Set([
		...Object.values(index),
		...labelColumns,
		...commentColumns,
		...peopleColumns.flat(),
	]);
	const ignored = [
		...new Set(
			header.filter((name, at) => !used.has(at) && name.trim()).map((name) => name.trim()),
		),
	];
	const jira = names.includes("issue key") && (index.issueId >= 0 || index.type >= 0);

	const raw = (row: string[], at: number) => (at < 0 ? "" : unguard(row[at] ?? "").trim());
	const cell = (row: string[], column: Column) => raw(row, index[column]);
	// Comments name their authors by account id; the people columns say whose id is whose.
	const people = new Map<string, string>();
	for (const row of rows) {
		for (const [name, id] of peopleColumns) {
			const person = raw(row, name);
			const account = raw(row, id);
			if (person && account) people.set(account, person);
		}
	}
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
		const issueId = cell(row, "issueId");
		if (issueId) keys.set(issueId.toLowerCase(), sourceId);
		const labels = labelColumns.flatMap((at) => splitLabels(raw(row, at), known));
		const type = cell(row, "type");
		if (type && !PLAIN_TYPES.has(type.toLowerCase())) labels.push(type);
		const comments: ImportedComment[] = [];
		commentColumns.forEach((at, n) => {
			const comment = readComment(raw(row, at), people);
			if (comment) comments.push({ sourceId: `${sourceId}:comment:${n}`, ...comment });
		});
		issues.push({
			sourceId,
			title,
			description: cell(row, "description") || null,
			status: withCategory(toStatus(cell(row, "status")), cell(row, "statusCategory")),
			priority: toPriority(cell(row, "priority")),
			labels: [...new Set(labels)],
			assignee: toPerson(cell(row, "assignee")),
			project: cell(row, "project") || null,
			parentSourceId: cell(row, "parent") || null,
			startDate: toDay(cell(row, "startDate")),
			dueDate: toDay(cell(row, "dueDate")),
			estimate: toEstimate(cell(row, "estimate")),
			createdAt: created,
			url: null,
			reference: key || null,
			comments,
		});
	});
	// Parents are named by key, or by Jira's issue id; within the file, either leads to the row.
	for (const issue of issues) {
		if (issue.parentSourceId) {
			issue.parentSourceId = keys.get(issue.parentSourceId.toLowerCase()) ?? null;
		}
	}
	return { source: { name: jira ? "Jira" : "CSV", issues }, ignored };
}

/**
 * A comment cell. Jira writes `date;author;text`, the author an account id in Jira Cloud or a
 * username in Jira Server; anything else is the comment's text alone.
 */
function readComment(
	value: string,
	people: ReadonlyMap<string, string>,
): Omit<ImportedComment, "sourceId"> | null {
	if (!value) return null;
	const match = /^([^;]+);([^;]*);([\s\S]*)$/.exec(value);
	const createdAt = match ? parseTime(match[1] ?? "") : null;
	if (!match || createdAt === null) return { body: value, author: null, createdAt: null };
	const body = (match[3] ?? "").trim();
	if (!body) return null;
	const account = (match[2] ?? "").trim();
	return {
		body,
		author: people.get(account) ?? (isAccountId(account) ? null : account || null),
		createdAt,
	};
}

/** Jira Cloud's account ids, such as `5b10ac8d82e05b22cc7d4ef5` or `712020:2a1c…`, mean nothing to people. */
function isAccountId(value: string): boolean {
	return /^(\d+:)?[0-9a-f-]{20,}$/i.test(value);
}

/** Jira's category of a status, which says what a status of the team's own naming means. */
const STATUS_CATEGORIES: Record<string, StatusCategory> = {
	"to do": "unstarted",
	"in progress": "started",
	done: "completed",
};

/** A status name the CSV words do not know takes its kind from the file's status category. */
function withCategory(status: ImportedStatus, category: string): ImportedStatus {
	const known = CATEGORIES[status.name.toLowerCase().replace(/[_-]+/g, " ")];
	const named = STATUS_CATEGORIES[category.toLowerCase()];
	return known || !named ? status : { ...status, category: named };
}

/** An assignee column holds an email or a name. */
function toPerson(value: string): ImportedPerson | null {
	if (!value) return null;
	return { name: value, email: value.includes("@") ? value : null };
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

/** The kind of status behind the names trackers use. */
const CATEGORIES: Record<string, StatusCategory> = {
	backlog: "backlog",
	triage: "backlog",
	icebox: "backlog",
	todo: "unstarted",
	"to do": "unstarted",
	open: "unstarted",
	new: "unstarted",
	unstarted: "unstarted",
	"in progress": "started",
	started: "started",
	doing: "started",
	active: "started",
	"in review": "started",
	review: "started",
	"code review": "started",
	done: "completed",
	closed: "completed",
	completed: "completed",
	complete: "completed",
	resolved: "completed",
	fixed: "completed",
	canceled: "canceled",
	cancelled: "canceled",
	"won't do": "canceled",
	"won't fix": "canceled",
	wontfix: "canceled",
	duplicate: "canceled",
	"not planned": "canceled",
};

/**
 * A status by its name, with the kind the names trackers use say it is. Unknown names are of the
 * backlog kind, so they land in a status of that name or in the team's backlog.
 */
export function toStatus(value: string): ImportedStatus {
	const name = value.trim();
	return {
		name,
		category: CATEGORIES[name.toLowerCase().replace(/[_-]+/g, " ")] ?? "backlog",
	};
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

/** `YYYY-MM-DD`, from a date or the date part of a timestamp, Jira's way of writing them too. */
function toDay(value: string): string | null {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	if (match?.[1]) return match[1];
	const jira = jiraTime(value);
	return jira === null ? null : new Date(jira).toISOString().slice(0, 10);
}

/** Whole points; Jira writes story points as `3.0`. */
function toEstimate(value: string): number | null {
	if (!/^\d+(\.\d+)?$/.test(value)) return null;
	const points = Math.round(Number(value));
	return points <= 1000 ? points : null;
}

function parseTime(value: string): number | null {
	if (!value) return null;
	const time = jiraTime(value) ?? Date.parse(value);
	return Number.isNaN(time) || time < Date.UTC(2000, 0, 1) ? null : time;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Jira's default format, `02/Nov/26 2:27 PM` or `02/Nov/2026`, read as UTC: the export does not
 * say which time zone its times are in.
 */
function jiraTime(value: string): number | null {
	const match =
		/^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?)?$/i.exec(
			value.trim(),
		);
	if (!match) return null;
	const [, day, monthName, yearText, hourText, minute, half] = match;
	const month = MONTHS.indexOf((monthName ?? "").toLowerCase());
	if (month < 0) return null;
	const year = Number(yearText) + ((yearText ?? "").length === 2 ? 2000 : 0);
	let hour = Number(hourText ?? 0);
	if (half) hour = (hour % 12) + (half.toUpperCase() === "PM" ? 12 : 0);
	const time = Date.UTC(year, month, Number(day), hour, Number(minute ?? 0));
	return new Date(time).getUTCDate() === Number(day) ? time : null;
}
