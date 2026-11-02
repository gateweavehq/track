import {
	type ActiveIssue,
	type Activity,
	type ArchivedIssues,
	type Comment,
	type Cycle,
	compareStatuses,
	type Issue,
	type IssueRelation,
	isActiveIssue,
	type Label,
	type Member,
	type Project,
	type ProjectUpdate,
	type SyncedIssue,
	type Team,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import type { SyncState } from "@gateweave/track-sync-client";
import { PRIORITY_META } from "#/components/issues/meta";
import { issueKey } from "./issues";
import { statusOf } from "./statuses";

// Exports are built in the browser from the local replica, and these functions only turn data
// into the file's text. The replica holds an archived issue as a slim row, so the rest of the
// archived issues comes from the server (`fetchArchivedIssues`) and is passed in as `archived`,
// read the way the page of one is: through the sync gateway, for members only. Without it, as
// offline, an export leaves archived issues out and says so; it never passes a slim row off as a
// whole issue.

export const EXPORT_FORMAT = "gateweave-track-export";
export const EXPORT_VERSION = 1;

/** The CSV columns, in order. A CSV importer reads the file back by these headers. */
export const CSV_COLUMNS = [
	"Key",
	"Title",
	"Description",
	"Team",
	"Status",
	"Priority",
	"Assignee",
	"Creator",
	"Project",
	"Parent",
	"Labels",
	"Start date",
	"Due date",
	"Estimate",
	"Created",
	"Updated",
] as const;

/** What an export reads: the replica's tables, read more than once, and whose workspace they are. */
export interface ExportSource {
	workspace: { slug: string; name: string };
	teams: readonly Team[];
	statuses: readonly WorkflowStatus[];
	members: readonly Member[];
	labels: readonly Label[];
	projects: readonly Project[];
	/** Exported whole, with their projects. Sources from before project updates have none. */
	projectUpdates?: readonly ProjectUpdate[];
	cycles: readonly Cycle[];
	/** Archived ones as their slim rows, as the replica holds them. */
	issues: readonly SyncedIssue[];
	comments: readonly Comment[];
	activities: readonly Activity[];
	relations: readonly IssueRelation[];
	/**
	 * The archived issues whole, with their comments and history, as the server sent them. Left
	 * out, the export has no archived issues, and the JSON's `notes` say how many it left out.
	 */
	archived?: ArchivedIssues | null;
}

/** The tables of a replica as an export source. Proposals are not exported. */
export function exportSourceFrom(
	state: SyncState,
	workspace: { slug: string; name: string },
): ExportSource {
	return {
		workspace,
		teams: [...state.teams.values()],
		statuses: [...state.statuses.values()],
		members: [...state.members.values()],
		labels: [...state.labels.values()],
		projects: [...state.projects.values()],
		projectUpdates: [...state.projectUpdates.values()],
		cycles: [...state.cycles.values()],
		issues: [...state.issues.values()],
		comments: [...state.comments.values()],
		activities: [...state.activities.values()],
		relations: [...state.relations.values()],
	};
}

/** The slice of the workspace an export holds: all of it, or one team's issues. */
interface Slice {
	teams: Team[];
	/** The statuses of the slice's teams, removed ones too, as history still names them. */
	statuses: WorkflowStatus[];
	statusesById: Map<string, WorkflowStatus>;
	members: Member[];
	labels: Label[];
	projects: Project[];
	projectUpdates: ProjectUpdate[];
	/** The cycles of the slice's teams, so every issue's cycle is in the file. */
	cycles: Cycle[];
	issues: ActiveIssue[];
	/** The slice's archived issues whole, from the server. Empty when it was not asked. */
	archived: Issue[];
	/** How many archived issues the replica has in the slice that the export leaves out. */
	archivedLeftOut: number;
	comments: Comment[];
	activities: Activity[];
	/** Relations between two issues of the slice, so both ends are in the file. */
	relations: IssueRelation[];
	teamsById: Map<string, Team>;
	membersById: Map<string, Member>;
	labelsById: Map<string, Label>;
	projectsById: Map<string, Project>;
	/** Every issue, whatever the slice, so a parent in another team still has its key. */
	issuesById: Map<string, SyncedIssue>;
}

function sliceOf(source: ExportSource, teamId: string | null): Slice {
	const teams = [...source.teams].sort((a, b) => a.key.localeCompare(b.key));
	const teamsById = new Map(teams.map((team) => [team.id, team]));
	const rank = new Map(teams.map((team, index) => [team.id, index]));
	const all = [...source.issues];
	const inSlice = (issue: { teamId: string }) => teamId === null || issue.teamId === teamId;
	type Numbered = { teamId: string; number: number };
	const byTeamAndNumber = (a: Numbered, b: Numbered) =>
		(rank.get(a.teamId) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(b.teamId) ?? Number.MAX_SAFE_INTEGER) || a.number - b.number;
	// The server's archived issues are the ones exported as archived, even one the replica has not
	// heard was archived yet: each issue is in the file once.
	const archived = (source.archived?.issues ?? []).filter(inSlice).sort(byTeamAndNumber);
	const archivedIds = new Set(archived.map((issue) => issue.id));
	const issues = all
		.filter(
			(issue): issue is ActiveIssue =>
				inSlice(issue) && isActiveIssue(issue) && !archivedIds.has(issue.id),
		)
		.sort(byTeamAndNumber);
	const archivedLeftOut = source.archived ? 0 : archivedInExport(source, teamId);
	const issueIds = new Set([...issues, ...archived].map((issue) => issue.id));
	const members = [...source.members];
	const labels = [...source.labels];
	const projects = [...source.projects];
	const statuses = [...source.statuses]
		.filter((status) => teamId === null || status.teamId === teamId)
		.sort(
			(a, b) =>
				(rank.get(a.teamId) ?? Number.MAX_SAFE_INTEGER) -
					(rank.get(b.teamId) ?? Number.MAX_SAFE_INTEGER) || compareStatuses(a, b),
		);
	return {
		teams,
		statuses,
		statusesById: new Map(statuses.map((status) => [status.id, status])),
		members,
		labels,
		projects,
		projectUpdates: [...(source.projectUpdates ?? [])].sort((a, b) => a.createdAt - b.createdAt),
		cycles: [...source.cycles]
			.filter((cycle) => teamId === null || cycle.teamId === teamId)
			.sort(
				(a, b) =>
					(rank.get(a.teamId) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(b.teamId) ?? Number.MAX_SAFE_INTEGER) || a.number - b.number,
			),
		issues,
		archived,
		archivedLeftOut,
		comments: unique([...source.comments, ...(source.archived?.comments ?? [])])
			.filter((comment) => issueIds.has(comment.issueId))
			.sort((a, b) => a.createdAt - b.createdAt),
		activities: unique([...source.activities, ...(source.archived?.activities ?? [])])
			.filter((activity) => issueIds.has(activity.issueId))
			.sort((a, b) => a.createdAt - b.createdAt),
		relations: [...source.relations]
			.filter((relation) => issueIds.has(relation.issueId) && issueIds.has(relation.relatedIssueId))
			.sort((a, b) => a.createdAt - b.createdAt),
		teamsById,
		membersById: new Map(members.map((member) => [member.id, member])),
		labelsById: new Map(labels.map((label) => [label.id, label])),
		projectsById: new Map(projects.map((project) => [project.id, project])),
		issuesById: new Map([...all, ...archived].map((issue) => [issue.id, issue])),
	};
}

/** Rows by id, the first of each: a comment can be in the replica and in the server's answer. */
function unique<T extends { id: string }>(rows: T[]): T[] {
	const seen = new Set<string>();
	return rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
}

/**
 * How many of a slice's issues the replica holds archived, slim: an export needs the server for
 * them. Zero, it is complete from the replica alone.
 */
export function archivedInExport(source: ExportSource, teamId: string | null = null): number {
	return [...source.issues].filter(
		(issue) => !isActiveIssue(issue) && (teamId === null || issue.teamId === teamId),
	).length;
}

/** What a JSON export made without the server says about the archived issues it left out. */
export function archivedLeftOutNote(count: number): string {
	return (
		`${count} archived ${count === 1 ? "issue is" : "issues are"} not in this export. ` +
		"This browser keeps only a short record of archived issues, and the rest is on the server, " +
		"which could not be reached. Export again while online to include them."
	);
}

// CSV

/**
 * A cell that starts with one of these is a formula to a spreadsheet, and members and agents can
 * write any text. A leading quote makes it text; the importer strips that quote again.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: string): string {
	const text = FORMULA_START.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Excel and friends read a file as UTF-8 only when it starts with a byte order mark. */
const BYTE_ORDER_MARK = "﻿";

/**
 * One row per issue, by team and number, as RFC 4180 CSV with a byte order mark. People are their
 * email, labels their names joined with ", ", dates `YYYY-MM-DD` and timestamps ISO 8601 in UTC.
 * Pass `teamId` for one team's issues. Archived issues follow, whole, when `archived` has them;
 * without it they are left out.
 */
export function issuesToCsv(source: ExportSource, teamId: string | null = null): string {
	const slice = sliceOf(source, teamId);
	const rows: string[][] = [[...CSV_COLUMNS]];
	for (const issue of [...slice.issues, ...slice.archived]) {
		const team = slice.teamsById.get(issue.teamId);
		rows.push([
			issueKey(team, issue),
			issue.title,
			issue.description ?? "",
			team?.name ?? "",
			statusOf(slice.statusesById, issue).name,
			PRIORITY_META[issue.priority].label,
			emailOf(slice, issue.assigneeId),
			emailOf(slice, issue.creatorId),
			(issue.projectId && slice.projectsById.get(issue.projectId)?.name) || "",
			parentKey(slice, issue.parentId),
			issue.labelIds
				.map((id) => slice.labelsById.get(id)?.name)
				.filter((name): name is string => name !== undefined)
				.join(", "),
			issue.startDate ?? "",
			issue.dueDate ?? "",
			issue.estimate === null ? "" : String(issue.estimate),
			new Date(issue.createdAt).toISOString(),
			new Date(issue.updatedAt).toISOString(),
		]);
	}
	return BYTE_ORDER_MARK + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function parentKey(slice: Slice, id: string | null): string {
	const parent = id ? slice.issuesById.get(id) : undefined;
	return parent ? issueKey(slice.teamsById.get(parent.teamId), parent) : "";
}

function emailOf(slice: Slice, id: string | null): string {
	return (id && slice.membersById.get(id)?.email) || "";
}

// JSON

/**
 * The whole export as one document, in the protocol's entity shapes. Teams, members, labels and
 * projects stay whole when `teamId` limits the issues, so every reference resolves; cycles and
 * statuses are the team's.
 */
export function workspaceToJson(
	source: ExportSource,
	teamId: string | null = null,
	exportedAt = new Date(),
): string {
	const slice = sliceOf(source, teamId);
	return JSON.stringify(
		{
			format: EXPORT_FORMAT,
			version: EXPORT_VERSION,
			exportedAt: exportedAt.toISOString(),
			workspace: { slug: source.workspace.slug, name: source.workspace.name },
			// The keys of a team's request form and intake address admit strangers to file
			// requests, so they stay out of files that travel.
			teams: slice.teams.map(({ intakeFormKey: _, intakeEmailKey: __, ...team }) => team),
			statuses: slice.statuses,
			members: slice.members.map(({ id, name, email, role }) => ({ id, name, email, role })),
			labels: slice.labels,
			projects: slice.projects,
			projectUpdates: slice.projectUpdates,
			cycles: slice.cycles,
			issues: slice.issues.map((issue) => ({
				...issue,
				key: issueKey(slice.teamsById.get(issue.teamId), issue),
			})),
			// Whole, from the server. Never left out without a word: `notes` says so when they are.
			archivedIssues: slice.archived.map((issue) => ({
				...issue,
				key: issueKey(slice.teamsById.get(issue.teamId), issue),
			})),
			notes: slice.archivedLeftOut > 0 ? [archivedLeftOutNote(slice.archivedLeftOut)] : [],
			comments: slice.comments,
			activities: slice.activities,
			relations: slice.relations,
		},
		null,
		"\t",
	);
}

// Download

export type ExportFormat = "csv" | "json";

/** `acme-2026-10-30.csv`, or `acme-eng-2026-10-30.json` for one team. `day` is `YYYY-MM-DD`. */
export function exportFileName(
	slug: string,
	teamKey: string | null,
	day: string,
	format: ExportFormat,
): string {
	return [slug, teamKey?.toLowerCase(), day].filter(Boolean).join("-") + `.${format}`;
}

/** Saves text as a file through the browser's download. */
export function downloadText(fileName: string, text: string, format: ExportFormat): void {
	const type = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
	const url = URL.createObjectURL(new Blob([text], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	// Revoked later: some browsers start the download after the click returns.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
