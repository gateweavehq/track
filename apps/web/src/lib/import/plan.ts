import {
	type Comment,
	calendarDate,
	compareStatuses,
	defaultStatuses,
	type IssuePriority,
	type IssueRelation,
	isActiveIssue,
	isClosedCategory,
	type Label,
	liveStatuses,
	MAX_LABELS_PER_ISSUE,
	MAX_STATUSES_PER_TEAM,
	type Member,
	type MutationInput,
	mutationSchema,
	type Project,
	type ProjectHealth,
	type ProjectStatus,
	type ProjectUpdate,
	type RelationType,
	type StatusCategory,
	type SyncedIssue,
	statusId,
	statusKeyFor,
	type Team,
	type WorkflowStatus,
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
	/**
	 * Each team's own statuses, by the team's key, where the source has teams with statuses (a
	 * Track export). When the import keeps the source's teams, those its team lacks are added.
	 */
	teamStatuses?: ReadonlyMap<string, readonly ImportedWorkflowStatus[]>;
}

export interface ImportedIssue {
	/**
	 * Stable across runs of the same import, such as `github:123456#42`. The issue's id in Track is
	 * made from it, so running an import again skips what it brought in before.
	 */
	sourceId: string;
	title: string;
	description: string | null;
	status: ImportedStatus;
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
	/**
	 * Archived in the source (a Track export). It is archived here too, after its comments and
	 * relations are in, when the status it gets closes it; otherwise it stays in lists.
	 */
	archived?: boolean;
}

/**
 * A status as the source has it. Each team in Track has its own statuses: the issue gets the
 * team's status of the same name, else the team's first of the same category.
 */
export interface ImportedStatus {
	name: string;
	category: StatusCategory;
}

/** One of a source team's statuses, as a Track export has it. */
export interface ImportedWorkflowStatus {
	key: string;
	name: string;
	category: StatusCategory;
	color: string | null;
	sortOrder: string;
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
	/** How it went, oldest first, where the source keeps that (a Track export). */
	updates?: ImportedProjectUpdate[];
}

/** A post on how a project was going. It becomes the importer's, so the text says who wrote it. */
export interface ImportedProjectUpdate {
	sourceId: string;
	health: ProjectHealth;
	body: string;
	author: string | null;
	createdAt: number | null;
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
	/** Archived ones as their slim rows: enough to skip what an earlier run brought in. */
	issues: ReadonlyMap<string, SyncedIssue>;
	comments: ReadonlyMap<string, Comment>;
	relations: ReadonlyMap<string, IssueRelation>;
	/** Updates an earlier run brought in are skipped. */
	projectUpdates?: ReadonlyMap<string, ProjectUpdate>;
	teams: Iterable<Team>;
	statuses: Iterable<WorkflowStatus>;
	labels: Iterable<Label>;
	projects: Iterable<Project>;
	members: Iterable<Member>;
}

export function importTargetFrom(state: SyncState): ImportTarget {
	return {
		issues: state.issues,
		comments: state.comments,
		relations: state.relations,
		projectUpdates: state.projectUpdates,
		teams: state.teams.values(),
		statuses: state.statuses.values(),
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
	/** Of the issues, how many are archived once they are in. */
	archived: number;
	/** Updates of the projects the import brings issues into or matches. */
	projectUpdates: number;
	/** Issues, comments, relations and project updates an earlier run imported. */
	skipped: number;
	newTeams: string[];
	/** Statuses added to teams, as `Name (KEY)`, the key being the team's. */
	newStatuses: string[];
	newLabels: string[];
	newProjects: string[];
}

export interface ImportOptions {
	/**
	 * Puts each issue in the team the source keeps it in, matched by key or created, instead of
	 * the one team, and adds the statuses that team has in the source and lacks here (only admins
	 * import, and only admins add statuses). Issues the source puts in no team still go to that one.
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
	const statuses = [...target.statuses];
	const labels = [...target.labels];
	const projects = [...target.projects];
	// Someone who left the workspace cannot be assigned.
	const members = [...target.members].filter((member) => member.removedAt === null);
	const newTeams: string[] = [];
	const newStatuses: string[] = [];
	const newLabels: string[] = [];
	const newProjects: string[] = [];

	const teamIds = new Map<string, string>();
	const teamFor = (issue: ImportedIssue) => {
		if (!keepTeams || !issue.team) return teamId;
		const key = issue.team.key.trim().toUpperCase();
		const cached = teamIds.get(key);
		if (cached) return cached;
		const known = teams.find((team) => team.key.toUpperCase() === key)?.id;
		if (known) {
			teamIds.set(key, known);
			addStatuses(known, key);
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
		// The server gives a new team the built-in statuses.
		statuses.push(...defaultStatuses(id, 0));
		addStatuses(id, key);
		return id;
	};

	// The source team's live statuses that the team here lacks, by name or by key (a renamed
	// status is still the same one), in the source's order and each after the one it follows
	// there. Statuses the source removed stay out: their issues already moved.
	const sourceStatuses = new Map(
		[...(source.teamStatuses ?? [])].map(([key, list]) => [key.trim().toUpperCase(), list]),
	);
	const addStatuses = (teamId: string, key: string) => {
		const wanted = [...(sourceStatuses.get(key) ?? [])].sort(compareStatuses);
		const own = () => liveStatuses(statuses.filter((status) => status.teamId === teamId));
		// Every key the team has used, removed ones included, as the server never reuses one.
		const taken = new Set(
			statuses.filter((status) => status.teamId === teamId).map((status) => status.key),
		);
		const matchOf = (status: ImportedWorkflowStatus) => {
			const name = status.name.trim().toLowerCase();
			return own().find((here) => here.name.toLowerCase() === name || here.key === status.key);
		};
		let previous: WorkflowStatus | undefined;
		for (const status of wanted) {
			const match = matchOf(status);
			if (match) {
				previous = match;
				continue;
			}
			const live = own();
			if (live.length >= MAX_STATUSES_PER_TEAM) break;
			const sameCategory = live.filter((here) => here.category === status.category);
			const after = previous?.category === status.category ? previous.sortOrder : null;
			const before =
				sameCategory.find((here) => after === null || here.sortOrder > after)?.sortOrder ?? null;
			const name = status.name.trim();
			const statusKey = taken.has(status.key) ? statusKeyFor(name, taken) : status.key;
			const create: MutationInput = {
				name: "status.create",
				args: {
					teamId,
					key: statusKey,
					name,
					category: status.category,
					color: status.color,
					sortOrder: generateKeyBetween(after, before),
				},
			};
			const parsed = mutationSchema.safeParse(create);
			// A status the server would refuse leaves its issues to the nearest one of its kind.
			if (!parsed.success || parsed.data.name !== "status.create") continue;
			mutations.push(parsed.data);
			const added: WorkflowStatus = {
				...parsed.data.args,
				id: statusId(teamId, statusKey),
				createdAt: 0,
				updatedAt: 0,
				removedAt: null,
			};
			statuses.push(added);
			taken.add(statusKey);
			newStatuses.push(`${name} (${key})`);
			previous = added;
		}
	};

	const statusFor = (teamId: string, wanted: ImportedStatus): string | undefined => {
		const own = liveStatuses(statuses.filter((status) => status.teamId === teamId));
		const name = wanted.name.trim().toLowerCase();
		return (
			own.find((status) => status.name.toLowerCase() === name) ??
			own.find((status) => status.category === wanted.category)
		)?.key;
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
	const toArchive: string[] = [];
	let sortOrder = lastSortOrder(target.issues.values());
	for (const issue of inImportOrder(source.issues)) {
		const id = ids.get(issue.sourceId);
		if (!id) continue;
		if (target.issues.has(id)) skipped++;
		else {
			const assignee = issue.assignee ? findMember(members, issue.assignee) : null;
			const parentId = issue.parentSourceId ? (ids.get(issue.parentSourceId) ?? null) : null;
			sortOrder = generateKeyBetween(sortOrder, null);
			const issueTeamId = teamFor(issue);
			const status = statusFor(issueTeamId, issue.status);
			mutations.push({
				name: "issue.create",
				args: {
					id,
					teamId: issueTeamId,
					title: oneLine(issue.title) || "Untitled",
					description: describe(
						issue,
						source.name,
						assignee ? null : (issue.assignee?.name ?? null),
					),
					// Without a match the issue gets the team's first status.
					...(status !== undefined && { status }),
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
			// Only a closed issue can be archived. Without a status of its own it gets the team's
			// first, which is open.
			const category = statuses.find(
				(known) => known.teamId === issueTeamId && known.key === status,
			)?.category;
			if (issue.archived && category && isClosedCategory(category)) toArchive.push(id);
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
	// The updates of the projects this import's issues are in, once those projects exist. A
	// project no imported issue names is not brought in, so neither are its updates.
	let projectUpdates = 0;
	for (const about of source.projects ?? []) {
		if (!about.updates?.length) continue;
		const folded = about.name.trim().toLowerCase();
		const id =
			projectIds.get(folded) ??
			projects.find((project) => project.name.toLowerCase() === folded)?.id;
		if (!id) continue;
		for (const update of [...about.updates].sort(byCreation)) {
			const updateId = await importId(update.sourceId);
			if (target.projectUpdates?.has(updateId)) {
				skipped++;
				continue;
			}
			const body = commentText(update, source.name);
			if (!body) continue;
			mutations.push({
				name: "projectUpdate.create",
				args: {
					id: updateId,
					projectId: id,
					health: update.health,
					body,
					...(update.createdAt !== null && { createdAt: update.createdAt }),
				},
			});
			projectUpdates++;
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
	// Archived last, once everything that belongs to them is in.
	for (const id of toArchive)
		mutations.push({ name: "issue.archive", args: { id, archived: true } });
	return {
		mutations,
		issues,
		comments,
		relations,
		archived: toArchive.length,
		projectUpdates,
		skipped,
		newTeams,
		newStatuses,
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

/** The last manual order among the issues lists show; archived ones have none in the replica. */
function lastSortOrder(issues: Iterable<SyncedIssue>): string | null {
	let last: string | null = null;
	for (const issue of issues) {
		if (!isActiveIssue(issue)) continue;
		if (last === null || issue.sortOrder > last) last = issue.sortOrder;
	}
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

function commentText(
	comment: Pick<ImportedComment, "body" | "author">,
	sourceName: string,
): string {
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
