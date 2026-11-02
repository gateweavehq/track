import type {
	ProjectHealth,
	ProjectStatus,
	RelationType,
	StatusCategory,
} from "@gateweave/track-protocol";
import type {
	ImportedComment,
	ImportedIssue,
	ImportedProject,
	ImportedRelation,
	ImportedStatus,
	ImportSource,
	ReadOptions,
} from "./plan";

// Issues from a Linear team, read in the browser with Linear's GraphQL API, which allows it. A
// personal API key reads them; it goes to Linear and nowhere else. Their comments, their
// relations, and the team's projects with their updates come along.

const API = "https://api.linear.app/graphql";

export interface LinearTeam {
	id: string;
	key: string;
	name: string;
}

interface Page<T> {
	nodes: T[];
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	priority: number;
	estimate: number | null;
	dueDate: string | null;
	createdAt: string;
	url: string;
	state: { name: string; type: string };
	assignee: { name: string; email: string } | null;
	project: { name: string } | null;
	parent: { id: string } | null;
	labels: { nodes: { name: string; color: string }[] };
	relations: { nodes: LinearRelation[] };
}

interface LinearRelation {
	id: string;
	/** blocks, duplicate, related or similar, from this issue to `relatedIssue`. */
	type: string;
	relatedIssue: { id: string } | null;
}

interface LinearProject {
	name: string;
	description: string;
	content: string | null;
	targetDate: string | null;
	status: { type: string } | null;
	lead: { name: string; email: string } | null;
	projectUpdates: {
		nodes: {
			id: string;
			body: string;
			health: string;
			createdAt: string;
			user: { name: string } | null;
		}[];
	};
}

interface LinearComment {
	id: string;
	body: string;
	createdAt: string;
	issue: { id: string } | null;
	user: { name: string } | null;
	botActor: { name: string | null } | null;
	externalUser: { name: string } | null;
}

// Pages of 100 keep each query well under Linear's limit of 10,000 complexity points: an issue
// with up to 20 labels and 10 relations costs about 52.
const ISSUES = `query Issues($team: ID!, $after: String) {
	issues(first: 100, after: $after, filter: { team: { id: { eq: $team } } }) {
		nodes {
			id identifier title description priority estimate dueDate createdAt url
			state { name type }
			assignee { name email }
			project { name }
			parent { id }
			labels(first: 20) { nodes { name color } }
			relations(first: 10) { nodes { id type relatedIssue { id } } }
		}
		pageInfo { hasNextPage endCursor }
	}
}`;

const COMMENTS = `query Comments($team: ID!, $after: String) {
	comments(first: 100, after: $after, filter: { issue: { team: { id: { eq: $team } } } }) {
		nodes {
			id body createdAt
			issue { id }
			user { name }
			botActor { name }
			externalUser { name }
		}
		pageInfo { hasNextPage endCursor }
	}
}`;

// Pages of 25 projects with up to 25 updates each stay under the limit too.
const PROJECTS = `query Projects($team: String!, $after: String) {
	team(id: $team) {
		projects(first: 25, after: $after) {
			nodes {
				name description content targetDate
				status { type }
				lead { name email }
				projectUpdates(first: 25) { nodes { id body health createdAt user { name } } }
			}
			pageInfo { hasNextPage endCursor }
		}
	}
}`;

/** The teams the key's owner can see, to choose one to import. */
export async function listLinearTeams(
	apiKey: string,
	options: ReadOptions = {},
): Promise<LinearTeam[]> {
	const data = await query<{ teams: Page<LinearTeam> }>(
		apiKey,
		"query Teams { teams(first: 250) { nodes { id key name } pageInfo { hasNextPage endCursor } } }",
		{},
		options,
	);
	return data.teams.nodes;
}

/** Reads every issue of a Linear team, with its comments. Archived issues stay behind. */
export async function readLinearImport(
	apiKey: string,
	team: LinearTeam,
	options: ReadOptions = {},
): Promise<ImportSource> {
	const read = { issues: 0, comments: 0 };
	const found: LinearIssue[] = [];
	for await (const page of pages<LinearIssue>(
		apiKey,
		ISSUES,
		(data) => data.issues,
		team.id,
		options,
	)) {
		found.push(...page);
		read.issues = found.length;
		options.onProgress?.({ ...read });
	}

	const comments = new Map<string, ImportedComment[]>();
	for await (const page of pages<LinearComment>(
		apiKey,
		COMMENTS,
		(data) => data.comments,
		team.id,
		options,
	)) {
		for (const comment of page) {
			if (!comment.issue) continue;
			const list = comments.get(comment.issue.id) ?? [];
			list.push({
				sourceId: `linear:comment:${comment.id}`,
				body: comment.body,
				author: comment.user?.name ?? comment.botActor?.name ?? comment.externalUser?.name ?? null,
				createdAt: Date.parse(comment.createdAt),
			});
			comments.set(comment.issue.id, list);
			read.comments++;
		}
		options.onProgress?.({ ...read });
	}

	const projects: ImportedProject[] = [];
	for await (const page of pages<LinearProject>(
		apiKey,
		PROJECTS,
		(data) => (data.team as { projects?: Page<LinearProject> } | null)?.projects,
		team.id,
		options,
	)) {
		projects.push(...page.map(toProject));
	}

	const labelColors = new Map<string, string>();
	const issues = found.map((issue): ImportedIssue => {
		for (const label of issue.labels.nodes) labelColors.set(label.name, label.color);
		return {
			sourceId: `linear:${issue.id}`,
			title: issue.title,
			description: issue.description,
			status: toStatus(issue.state),
			// Linear numbers priorities as Track does: none, urgent, high, medium, low.
			priority: ([0, 1, 2, 3, 4] as const).find((value) => value === issue.priority) ?? 0,
			labels: issue.labels.nodes.map((label) => label.name),
			assignee: issue.assignee,
			project: issue.project?.name ?? null,
			parentSourceId: issue.parent ? `linear:${issue.parent.id}` : null,
			startDate: null,
			dueDate: issue.dueDate,
			estimate: issue.estimate,
			createdAt: Date.parse(issue.createdAt),
			url: issue.url,
			reference: issue.identifier,
			comments: comments.get(issue.id) ?? [],
		};
	});
	return { name: "Linear", issues, labelColors, projects, relations: toRelations(found) };
}

const RELATION_TYPES: Record<string, RelationType> = {
	blocks: "blocks",
	duplicate: "duplicate",
	related: "related",
};

/**
 * Linear's relations, each read from the issue it starts at. Two issues have one relation in
 * Track, so the first between a pair wins. "Similar" is Linear's own guess, and stays behind.
 */
function toRelations(issues: readonly LinearIssue[]): ImportedRelation[] {
	const pairs = new Set<string>();
	const relations: ImportedRelation[] = [];
	for (const issue of issues) {
		for (const relation of issue.relations?.nodes ?? []) {
			const type = RELATION_TYPES[relation.type];
			if (!type || !relation.relatedIssue) continue;
			const pair = [issue.id, relation.relatedIssue.id].sort().join(" ");
			if (pairs.has(pair)) continue;
			pairs.add(pair);
			relations.push({
				sourceId: `linear:relation:${relation.id}`,
				type,
				issueSourceId: `linear:${issue.id}`,
				relatedIssueSourceId: `linear:${relation.relatedIssue.id}`,
			});
		}
	}
	return relations;
}

const PROJECT_STATUSES: Record<string, ProjectStatus> = {
	backlog: "planned",
	planned: "planned",
	started: "started",
	paused: "paused",
	completed: "completed",
	canceled: "canceled",
};

const HEALTHS: Record<string, ProjectHealth> = {
	onTrack: "on_track",
	atRisk: "at_risk",
	offTrack: "off_track",
};

function toProject(project: LinearProject): ImportedProject {
	// A project's summary is its description; the document under it, its content.
	const description = [project.description, project.content]
		.map((part) => part?.trim() ?? "")
		.filter(Boolean)
		.join("\n\n");
	return {
		name: project.name,
		description: description || null,
		status: PROJECT_STATUSES[project.status?.type ?? ""] ?? "planned",
		lead: project.lead,
		targetDate: project.targetDate,
		updates: project.projectUpdates.nodes.map((update) => ({
			sourceId: `linear:project-update:${update.id}`,
			health: HEALTHS[update.health] ?? "on_track",
			body: update.body,
			author: update.user?.name ?? null,
			createdAt: Date.parse(update.createdAt),
		})),
	};
}

/** Linear's states are the team's own, as in Track, and each has one of a few types. */
function toStatus(state: { name: string; type: string }): ImportedStatus {
	return { name: state.name, category: LINEAR_CATEGORIES[state.type] ?? "backlog" };
}

const LINEAR_CATEGORIES: Record<string, StatusCategory> = {
	backlog: "backlog",
	triage: "backlog",
	unstarted: "unstarted",
	started: "started",
	completed: "completed",
	canceled: "canceled",
	duplicate: "canceled",
};

async function* pages<T>(
	apiKey: string,
	document: string,
	pick: (data: Record<string, unknown>) => unknown,
	team: string,
	options: ReadOptions,
) {
	let after: string | null = null;
	do {
		const data: Record<string, unknown> = await query(apiKey, document, { team, after }, options);
		const page = pick(data) as Page<T> | undefined;
		if (!page) return;
		yield page.nodes;
		after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
	} while (after);
}

async function query<T>(
	apiKey: string,
	document: string,
	variables: Record<string, unknown>,
	options: ReadOptions,
): Promise<T> {
	const response = await (options.fetch ?? fetch)(API, {
		method: "POST",
		// A personal API key goes as it is; only OAuth tokens take "Bearer".
		headers: { "Content-Type": "application/json", Authorization: apiKey.trim() },
		body: JSON.stringify({ query: document, variables }),
		signal: options.signal,
	});
	const body = (await response.json().catch(() => null)) as {
		data?: T;
		errors?: { message: string; extensions?: { code?: string } }[];
	} | null;
	const codes = body?.errors?.map((error) => error.extensions?.code) ?? [];
	if (response.status === 401 || codes.includes("AUTHENTICATION_ERROR")) {
		throw new Error("Linear did not accept the API key.");
	}
	if (response.status === 429 || codes.includes("RATELIMITED")) {
		throw new Error("Linear's limit on requests was reached. Try again in an hour.");
	}
	if (!response.ok || !body?.data) {
		throw new Error(
			body?.errors?.[0]?.message
				? `Linear answered: ${body.errors[0].message}`
				: `Linear answered with an error (${response.status}). Try again later.`,
		);
	}
	return body.data;
}
