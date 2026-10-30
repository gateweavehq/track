import type { IssueStatus } from "@gateweave/track-protocol";
import type { ImportedComment, ImportedIssue, ImportSource, ReadOptions } from "./plan";

// Issues from a Linear team, read in the browser with Linear's GraphQL API, which allows it. A
// personal API key reads them; it goes to Linear and nowhere else.

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
// with up to 20 labels costs about 31.
const ISSUES = `query Issues($team: ID!, $after: String) {
	issues(first: 100, after: $after, filter: { team: { id: { eq: $team } } }) {
		nodes {
			id identifier title description priority estimate dueDate createdAt url
			state { name type }
			assignee { name email }
			project { name }
			parent { id }
			labels(first: 20) { nodes { name color } }
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
	for await (const page of pages<LinearIssue>(apiKey, ISSUES, "issues", team.id, options)) {
		found.push(...page);
		read.issues = found.length;
		options.onProgress?.({ ...read });
	}

	const comments = new Map<string, ImportedComment[]>();
	for await (const page of pages<LinearComment>(apiKey, COMMENTS, "comments", team.id, options)) {
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
	return { name: "Linear", issues, labelColors };
}

/** Linear's states are the team's own, but each has one of a few types. */
function toStatus(state: { name: string; type: string }): IssueStatus {
	switch (state.type) {
		case "unstarted":
			return "todo";
		case "started":
			return /review/i.test(state.name) ? "in_review" : "in_progress";
		case "completed":
			return "done";
		case "canceled":
		case "duplicate":
			return "canceled";
		default:
			return "backlog";
	}
}

async function* pages<T>(
	apiKey: string,
	document: string,
	field: string,
	team: string,
	options: ReadOptions,
) {
	let after: string | null = null;
	do {
		const data: Record<string, Page<T>> = await query(apiKey, document, { team, after }, options);
		const page = data[field];
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
