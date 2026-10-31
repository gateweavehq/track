import type {
	Activity,
	Comment,
	Cycle,
	Issue,
	IssueRelation,
	Label,
	Member,
	Project,
	Team,
} from "@gateweave/track-protocol";
import type { SyncState } from "@gateweave/track-sync-client";
import { PRIORITY_META, STATUS_META } from "#/components/issues/meta";
import { issueKey } from "./issues";

// Exports are built in the browser from the local replica: no server route, so nothing new
// can leak data, and it works offline. These functions only turn data into the file's text.

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

/** What an export reads: the replica's tables, plus which workspace they belong to. */
export interface ExportSource {
	workspace: { slug: string; name: string };
	teams: Iterable<Team>;
	members: Iterable<Member>;
	labels: Iterable<Label>;
	projects: Iterable<Project>;
	cycles: Iterable<Cycle>;
	issues: Iterable<Issue>;
	comments: Iterable<Comment>;
	activities: Iterable<Activity>;
	relations: Iterable<IssueRelation>;
}

/** The tables of a replica as an export source. Proposals are not exported. */
export function exportSourceFrom(
	state: SyncState,
	workspace: { slug: string; name: string },
): ExportSource {
	return {
		workspace,
		teams: state.teams.values(),
		members: state.members.values(),
		labels: state.labels.values(),
		projects: state.projects.values(),
		cycles: state.cycles.values(),
		issues: state.issues.values(),
		comments: state.comments.values(),
		activities: state.activities.values(),
		relations: state.relations.values(),
	};
}

/** The slice of the workspace an export holds: all of it, or one team's issues. */
interface Slice {
	teams: Team[];
	members: Member[];
	labels: Label[];
	projects: Project[];
	/** The cycles of the slice's teams, so every issue's cycle is in the file. */
	cycles: Cycle[];
	issues: Issue[];
	comments: Comment[];
	activities: Activity[];
	/** Relations between two issues of the slice, so both ends are in the file. */
	relations: IssueRelation[];
	teamsById: Map<string, Team>;
	membersById: Map<string, Member>;
	labelsById: Map<string, Label>;
	projectsById: Map<string, Project>;
	/** Every issue, whatever the slice, so a parent in another team still has its key. */
	issuesById: Map<string, Issue>;
}

function sliceOf(source: ExportSource, teamId: string | null): Slice {
	const teams = [...source.teams].sort((a, b) => a.key.localeCompare(b.key));
	const teamsById = new Map(teams.map((team) => [team.id, team]));
	const rank = new Map(teams.map((team, index) => [team.id, index]));
	const all = [...source.issues];
	const issues = all
		.filter((issue) => teamId === null || issue.teamId === teamId)
		.sort(
			(a, b) =>
				(rank.get(a.teamId) ?? Number.MAX_SAFE_INTEGER) -
					(rank.get(b.teamId) ?? Number.MAX_SAFE_INTEGER) || a.number - b.number,
		);
	const issueIds = new Set(issues.map((issue) => issue.id));
	const members = [...source.members];
	const labels = [...source.labels];
	const projects = [...source.projects];
	return {
		teams,
		members,
		labels,
		projects,
		cycles: [...source.cycles]
			.filter((cycle) => teamId === null || cycle.teamId === teamId)
			.sort(
				(a, b) =>
					(rank.get(a.teamId) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(b.teamId) ?? Number.MAX_SAFE_INTEGER) || a.number - b.number,
			),
		issues,
		comments: [...source.comments]
			.filter((comment) => issueIds.has(comment.issueId))
			.sort((a, b) => a.createdAt - b.createdAt),
		activities: [...source.activities]
			.filter((activity) => issueIds.has(activity.issueId))
			.sort((a, b) => a.createdAt - b.createdAt),
		relations: [...source.relations]
			.filter((relation) => issueIds.has(relation.issueId) && issueIds.has(relation.relatedIssueId))
			.sort((a, b) => a.createdAt - b.createdAt),
		teamsById,
		membersById: new Map(members.map((member) => [member.id, member])),
		labelsById: new Map(labels.map((label) => [label.id, label])),
		projectsById: new Map(projects.map((project) => [project.id, project])),
		issuesById: new Map(all.map((issue) => [issue.id, issue])),
	};
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
 * Pass `teamId` for one team's issues.
 */
export function issuesToCsv(source: ExportSource, teamId: string | null = null): string {
	const slice = sliceOf(source, teamId);
	const rows: string[][] = [[...CSV_COLUMNS]];
	for (const issue of slice.issues) {
		const team = slice.teamsById.get(issue.teamId);
		rows.push([
			issueKey(team, issue),
			issue.title,
			issue.description ?? "",
			team?.name ?? "",
			STATUS_META[issue.status].label,
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
 * projects stay whole when `teamId` limits the issues, so every reference resolves; cycles are
 * the team's.
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
			teams: slice.teams,
			members: slice.members.map(({ id, name, email, role }) => ({ id, name, email, role })),
			labels: slice.labels,
			projects: slice.projects,
			cycles: slice.cycles,
			issues: slice.issues.map((issue) => ({
				...issue,
				key: issueKey(slice.teamsById.get(issue.teamId), issue),
			})),
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
