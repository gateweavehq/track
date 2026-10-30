import {
	type Comment,
	calendarDate,
	type Issue,
	type IssuePriority,
	type IssueRelation,
	type IssueStatus,
	type Label,
	MAX_LABELS_PER_ISSUE,
	type Member,
	type MutationInput,
	mutationSchema,
	type Project,
	type ProjectStatus,
	type RelationType,
	type Team,
} from "@gateweave/track-protocol";
import type { SyncState } from "@gateweave/track-sync-client";
import { generateKeyBetween } from "fractional-indexing";
import { defaultLabelColor, findLabelByName } from "#/lib/labels";

// Importing issues from another tracker. Each importer (CSV, JSON, GitHub, Linear) reads its source
// into an `ImportSource`; everything after that is shared here: matching labels, projects and
// people, and turning the source into the same mutations people make, sent at a pace the sync
// client keeps up with. Nothing new on the server but the original dates an admin may keep.

/** What an importer read: issues in the shape Track needs, with names where Track has ids. */
export interface ImportSource {
	/** Where the issues came from, for notes in the imported text: "GitHub", "Linear", "CSV". */
	name: string;
	issues: ImportedIssue[];
	/** Colors for labels the source names (`#rrggbb`), where it has them, by name in any case. */
	labelColors?: ReadonlyMap<string, string>;
	/** What the source says about the projects its issues name, for those that get created. */
	projects?: ImportedProject[];
	/** Relations between issues of this import. */
	relations?: ImportedRelation[];
}

export interface ImportedIssue {
	/**
	 * Stable across runs of the same import, such as `github:123456#42`. The issue's id in Track is
	 * made from it, so running an import again skips what it brought in before.
	 */
	sourceId: string;
	title: string;
	description: string | null;
	status: IssueStatus;
	priority: IssuePriority;
	/** Label names. Missing labels are created. */
	labels: string[];
	/** Matched to a member by email, then by name. Unmatched, the name is kept in the text. */
	assignee: ImportedPerson | null;
	/** A project's name. Missing projects are created. */
	project: string | null;
	/** The `sourceId` of the parent, when the parent is in the same import. */
	parentSourceId: string | null;
	/**
	 * The team the source keeps the issue in, where it has teams. Used when the import keeps the
	 * source's teams: matched by key, else created.
	 */
	team?: { key: string; name: string } | null;
	startDate: string | null;
	dueDate: string | null;
	estimate: number | null;
	/** When the issue was opened in the source (epoch ms). */
	createdAt: number | null;
	/** The issue in the source, linked from the imported text. */
	url: string | null;
	/** How the source refers to the issue, such as `acme/api#42`. */
	reference: string | null;
	comments: ImportedComment[];
}

export interface ImportedPerson {
	/** A name or a username, as the source shows it. */
	name: string;
	email: string | null;
}

export interface ImportedProject {
	name: string;
	description: string | null;
	status: ProjectStatus;
	lead: ImportedPerson | null;
	targetDate: string | null;
}

export interface ImportedRelation {
	sourceId: string;
	type: RelationType;
	/** The `sourceId`s of the two issues, in the order `IssueRelation` keeps them. */
	issueSourceId: string;
	relatedIssueSourceId: string;
}

export interface ImportedComment {
	sourceId: string;
	body: string;
	/** Who wrote it in the source. The comment is the importer's, so the text says so. */
	author: string | null;
	createdAt: number | null;
}

/** What an importer that reads from another service's API takes, besides the source. */
export interface ReadOptions {
	/** Stands in for the global `fetch` in tests. */
	fetch?: typeof fetch;
	signal?: AbortSignal;
	onProgress?: (read: { issues: number; comments: number }) => void;
}

/** The part of a workspace an import reads, to match names and skip what is there. */
export interface ImportTarget {
	issues: ReadonlyMap<string, Issue>;
	comments: ReadonlyMap<string, Comment>;
	relations: ReadonlyMap<string, IssueRelation>;
	teams: Iterable<Team>;
	labels: Iterable<Label>;
	projects: Iterable<Project>;
	members: Iterable<Member>;
}

export function importTargetFrom(state: SyncState): ImportTarget {
	return {
		issues: state.issues,
		comments: state.comments,
		relations: state.relations,
		teams: state.teams.values(),
		labels: state.labels.values(),
		projects: state.projects.values(),
		members: state.members.values(),
	};
}

export interface ImportPlan {
	/**
	 * In the order they must be sent: each issue after the team, labels and project it needs and
	 * after its parent, followed by its comments; then the relations between them.
	 */
	mutations: MutationInput[];
	issues: number;
	comments: number;
	relations: number;
	/** Issues, comments and relations an earlier run imported. */
	skipped: number;
	newTeams: string[];
	newLabels: string[];
	newProjects: string[];
}

export interface ImportOptions {
	/**
	 * Puts each issue in the team the source keeps it in, matched by key or created, instead of
	 * the one team. Issues the source puts in no team still go to that one.
	 */
	keepTeams?: boolean;
}

/** The id an imported item gets in Track: the same for the same source item, every time. */
export async function importId(sourceId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceId));
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
	return `import-${hex.join("").slice(0, 32)}`;
}

/** Turns what an importer read into the mutations that bring it into `teamId`. */
export async function planImport(
	source: ImportSource,
	target: ImportTarget,
	teamId: string,
	{ keepTeams = false }: ImportOptions = {},
): Promise<ImportPlan> {
	const mutations: MutationInput[] = [];
	const teams = [...target.teams];
	const labels = [...target.labels];
	const projects = [...target.projects];
	// Someone who left the workspace cannot be assigned.
	const members = [...target.members].filter((member) => member.removedAt === null);
	const newTeams: string[] = [];
	const newLabels: string[] = [];
	const newProjects: string[] = [];

	const teamIds = new Map<string, string>();
	const teamFor = (issue: ImportedIssue) => {
		if (!keepTeams || !issue.team) return teamId;
		const key = issue.team.key.trim().toUpperCase();
		const known = teamIds.get(key) ?? teams.find((team) => team.key.toUpperCase() === key)?.id;
		if (known) {
			teamIds.set(key, known);
			return known;
		}
		const id = crypto.randomUUID();
		const name = issue.team.name.trim().slice(0, 64) || key;
		const create: MutationInput = { name: "team.create", args: { id, key, name } };
		// A key the server would refuse sends the issue to the one team instead.
		if (!mutationSchema.safeParse(create).success) return teamId;
		mutations.push(create);
		newTeams.push(`${name} (${key})`);
		teamIds.set(key, id);
		return id;
	};

	const colors = new Map(
		[...(source.labelColors ?? [])].map(([name, color]) => [name.trim().toLowerCase(), color]),
	);
	const labelIds = new Map<string, string>();
	const labelId = (name: string) => {
		const folded = name.trim().toLowerCase();
		const known = labelIds.get(folded) ?? findLabelByName(labels, name)?.id;
		if (known) {
			labelIds.set(folded, known);
			return known;
		}
		const id = crypto.randomUUID();
		const trimmed = name.trim().slice(0, 64);
		const sourceColor = colors.get(folded)?.toLowerCase();
		const color =
			sourceColor && /^#[0-9a-f]{6}$/.test(sourceColor) ? sourceColor : defaultLabelColor(trimmed);
		mutations.push({ name: "label.create", args: { id, name: trimmed, color } });
		newLabels.push(trimmed);
		labelIds.set(folded, id);
		return id;
	};

	const projectIds = new Map<string, string>();
	const projectId = (name: string) => {
		const folded = name.trim().toLowerCase();
		const known =
			projectIds.get(folded) ??
			projects.find((project) => project.name.toLowerCase() === folded)?.id;
		if (known) {
			projectIds.set(folded, known);
			return known;
		}
		const id = crypto.randomUUID();
		const trimmed = name.trim().slice(0, 64);
		const about = source.projects?.find((project) => project.name.trim().toLowerCase() === folded);
		const lead = about?.lead ? findMember(members, about.lead) : null;
		mutations.push({
			name: "project.create",
			args: {
				id,
				name: trimmed,
				description: about?.description?.trim().slice(0, 100_000) || null,
				status: about?.status ?? "planned",
				leadId: lead?.id ?? null,
				targetDate: validDate(about?.targetDate ?? null),
			},
		});
		newProjects.push(trimmed);
		projectIds.set(folded, id);
		return id;
	};

	const ids = new Map<string, string>();
	for (const issue of source.issues) ids.set(issue.sourceId, await importId(issue.sourceId));

	let issues = 0;
	let comments = 0;
	let relations = 0;
	let skipped = 0;
	let sortOrder = lastSortOrder(target.issues.values());
	for (const issue of inImportOrder(source.issues)) {
		const id = ids.get(issue.sourceId);
		if (!id) continue;
		if (target.issues.has(id)) skipped++;
		else {
			const assignee = issue.assignee ? findMember(members, issue.assignee) : null;
			const parentId = issue.parentSourceId ? (ids.get(issue.parentSourceId) ?? null) : null;
			sortOrder = generateKeyBetween(sortOrder, null);
			mutations.push({
				name: "issue.create",
				args: {
					id,
					teamId: teamFor(issue),
					title: oneLine(issue.title) || "Untitled",
					description: describe(
						issue,
						source.name,
						assignee ? null : (issue.assignee?.name ?? null),
					),
					status: issue.status,
					priority: issue.priority,
					assigneeId: assignee?.id ?? null,
					projectId: issue.project?.trim() ? projectId(issue.project) : null,
					parentId,
					startDate: validDate(issue.startDate),
					dueDate: validDate(issue.dueDate),
					estimate: validEstimate(issue.estimate),
					labelIds: [...new Set(issue.labels.filter((name) => name.trim()).map(labelId))].slice(
						0,
						MAX_LABELS_PER_ISSUE,
					),
					sortOrder,
					...(issue.createdAt !== null && { createdAt: issue.createdAt }),
				},
			});
			issues++;
		}
		for (const comment of [...issue.comments].sort(byCreation)) {
			const commentId = await importId(comment.sourceId);
			if (target.comments.has(commentId)) {
				skipped++;
				continue;
			}
			const body = commentText(comment, source.name);
			if (!body) continue;
			mutations.push({
				name: "comment.create",
				args: {
					id: commentId,
					issueId: id,
					body,
					...(comment.createdAt !== null && { createdAt: comment.createdAt }),
				},
			});
			comments++;
		}
	}
	// Last, so both issues of each exist.
	for (const relation of source.relations ?? []) {
		const issueId = ids.get(relation.issueSourceId);
		const relatedIssueId = ids.get(relation.relatedIssueSourceId);
		if (!issueId || !relatedIssueId || issueId === relatedIssueId) continue;
		const id = await importId(relation.sourceId);
		if (target.relations.has(id)) {
			skipped++;
			continue;
		}
		mutations.push({
			name: "relation.create",
			args: { id, type: relation.type, issueId, relatedIssueId },
		});
		relations++;
	}
	return {
		mutations,
		issues,
		comments,
		relations,
		skipped,
		newTeams,
		newLabels,
		newProjects,
	};
}

/**
 * Oldest first, so numbers follow the source's order, and every parent before its sub-issues,
 * since the server only takes a parent that exists.
 */
function inImportOrder(issues: readonly ImportedIssue[]): ImportedIssue[] {
	const bySource = new Map(issues.map((issue) => [issue.sourceId, issue]));
	const placed = new Set<string>();
	const ordered: ImportedIssue[] = [];
	const place = (issue: ImportedIssue, path: Set<string>) => {
		if (placed.has(issue.sourceId) || path.has(issue.sourceId)) return;
		path.add(issue.sourceId);
		const parent = issue.parentSourceId ? bySource.get(issue.parentSourceId) : undefined;
		if (parent) place(parent, path);
		placed.add(issue.sourceId);
		ordered.push(issue);
	};
	for (const issue of [...issues].sort(byCreation)) place(issue, new Set());
	return ordered;
}

function byCreation(a: { createdAt: number | null }, b: { createdAt: number | null }): number {
	return (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER);
}

function lastSortOrder(issues: Iterable<Issue>): string | null {
	let last: string | null = null;
	for (const issue of issues) if (last === null || issue.sortOrder > last) last = issue.sortOrder;
	return last;
}

function findMember(members: readonly Member[], person: ImportedPerson): Member | null {
	const email = person.email?.trim().toLowerCase();
	const name = person.name.trim().toLowerCase();
	return (
		(email ? members.find((member) => member.email.toLowerCase() === email) : undefined) ??
		members.find((member) => member.name.toLowerCase() === name) ??
		null
	);
}

/** The description, with a line on where the issue came from and who had it there. */
function describe(issue: ImportedIssue, sourceName: string, unmatched: string | null) {
	const notes: string[] = [];
	if (issue.url) {
		notes.push(`Imported from [${escapeLinkText(issue.reference ?? sourceName)}](${issue.url}).`);
	}
	if (unmatched) notes.push(`Assigned in ${sourceName} to ${unmatched}.`);
	const text = issue.description?.trim() ?? "";
	const footer = notes.length > 0 ? `_${notes.join(" ")}_` : "";
	const description = [text, footer].filter(Boolean).join("\n\n");
	return description ? description.slice(0, 100_000) : null;
}

function commentText(comment: ImportedComment, sourceName: string): string {
	const body = comment.body.trim();
	if (!body) return "";
	const byline = comment.author ? `_${comment.author} wrote in ${sourceName}:_\n\n` : "";
	return `${byline}${body}`.slice(0, 100_000);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 512);
}

function escapeLinkText(text: string): string {
	return text.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

function validDate(value: string | null): string | null {
	return value && calendarDate.safeParse(value).success ? value : null;
}

function validEstimate(value: number | null): number | null {
	return value !== null && Number.isInteger(value) && value >= 0 && value <= 1000 ? value : null;
}

export interface ImportProgress {
	/** Mutations the server has answered. */
	done: number;
	total: number;
	/** Mutations the server refused, with its reasons. */
	failed: { mutation: MutationInput; message: string }[];
}

/**
 * Sends a plan's mutations, keeping a few dozen waiting on the server at a time: every pending
 * mutation is replayed whenever the server's state moves, so thousands at once would slow the
 * whole app. Stops sending when `signal` aborts; running the import again finishes the rest.
 */
export async function runImport(
	mutate: (mutation: MutationInput) => Promise<number>,
	mutations: readonly MutationInput[],
	onProgress: (progress: ImportProgress) => void,
	signal?: AbortSignal,
	window = 40,
): Promise<ImportProgress> {
	const progress: ImportProgress = { done: 0, total: mutations.length, failed: [] };
	const waiting = new Set<Promise<void>>();
	for (const mutation of mutations) {
		if (signal?.aborted) break;
		const settled = mutate(mutation).then(
			() => {},
			(error: unknown) => {
				progress.failed.push({
					mutation,
					message: error instanceof Error ? error.message : String(error),
				});
			},
		);
		const tracked = settled.finally(() => {
			waiting.delete(tracked);
			progress.done++;
			onProgress({ ...progress, failed: [...progress.failed] });
		});
		waiting.add(tracked);
		if (waiting.size >= window) await Promise.race(waiting);
	}
	await Promise.all(waiting);
	return progress;
}
