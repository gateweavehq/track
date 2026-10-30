import type { IssueStatus } from "@gateweave/track-protocol";
import type { ImportedComment, ImportedIssue, ImportSource, ReadOptions } from "./plan";

// Issues from a GitHub repository, read in the browser with GitHub's REST API, which allows it.
// Pull requests are left out. A public repository needs no token, but GitHub then allows only 60
// requests an hour; the token goes to GitHub and nowhere else.

const API = "https://api.github.com";

export interface GitHubRepository {
	owner: string;
	name: string;
}

/** `owner/name`, or a link to the repository or to anything in it. */
export function parseRepository(value: string): GitHubRepository | null {
	const match =
		/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(
			value.trim(),
		);
	if (!match?.[1] || !match[2]) return null;
	return { owner: match[1], name: match[2] };
}

interface GitHubUser {
	login: string;
}

interface GitHubIssue {
	number: number;
	title: string;
	body: string | null;
	state: "open" | "closed";
	state_reason?: string | null;
	labels: (string | { name?: string; color?: string | null })[];
	assignee: GitHubUser | null;
	milestone: { title: string } | null;
	created_at: string;
	html_url: string;
	comments: number;
	pull_request?: unknown;
	parent_issue_url?: string | null;
}

interface GitHubComment {
	id: number;
	issue_url: string;
	body?: string | null;
	user: GitHubUser | null;
	created_at: string;
}

/** Reads every issue of a repository, open and closed, with its comments. */
export async function readGitHubImport(
	repository: GitHubRepository,
	token: string,
	options: ReadOptions = {},
): Promise<ImportSource & { pullRequests: number }> {
	const get = (url: string) => request(url, token.trim(), options);
	const repo = (await (
		await get(`${API}/repos/${repository.owner}/${repository.name}`)
	).json()) as { id: number; full_name: string };
	const read = { issues: 0, comments: 0 };

	const found: GitHubIssue[] = [];
	let pullRequests = 0;
	for await (const page of pages<GitHubIssue>(
		get,
		`${API}/repos/${repo.full_name}/issues?state=all&sort=created&direction=asc&per_page=100`,
	)) {
		for (const issue of page) {
			if (issue.pull_request) pullRequests++;
			else found.push(issue);
		}
		read.issues = found.length;
		options.onProgress?.({ ...read });
	}

	// One list for the whole repository costs far fewer requests than one per issue. It has pull
	// requests' comments too, which are left out with them.
	const comments = new Map<number, ImportedComment[]>();
	if (found.some((issue) => issue.comments > 0)) {
		const numbers = new Set(found.map((issue) => issue.number));
		for await (const page of pages<GitHubComment>(
			get,
			`${API}/repos/${repo.full_name}/issues/comments?sort=created&direction=asc&per_page=100`,
		)) {
			for (const comment of page) {
				const number = Number(comment.issue_url.split("/").at(-1));
				if (!numbers.has(number)) continue;
				const list = comments.get(number) ?? [];
				list.push({
					sourceId: `github:comment:${comment.id}`,
					body: comment.body ?? "",
					author: comment.user?.login ?? null,
					createdAt: Date.parse(comment.created_at),
				});
				comments.set(number, list);
				read.comments++;
			}
			options.onProgress?.({ ...read });
		}
	}

	const labelColors = new Map<string, string>();
	const sourceId = (number: number) => `github:${repo.id}#${number}`;
	const issues = found.map((issue): ImportedIssue => {
		const labels: string[] = [];
		for (const label of issue.labels) {
			const name = typeof label === "string" ? label : label.name;
			if (!name) continue;
			labels.push(name);
			if (typeof label !== "string" && label.color) labelColors.set(name, `#${label.color}`);
		}
		const parent = issue.parent_issue_url?.match(/\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
		return {
			sourceId: sourceId(issue.number),
			title: issue.title,
			description: issue.body,
			status: toStatus(issue),
			priority: 0,
			labels,
			assignee: issue.assignee ? { name: issue.assignee.login, email: null } : null,
			project: issue.milestone?.title ?? null,
			// A parent in another repository is not part of this import.
			parentSourceId:
				parent?.[1]?.toLowerCase() === repo.full_name.toLowerCase()
					? sourceId(Number(parent[2]))
					: null,
			startDate: null,
			dueDate: null,
			estimate: null,
			createdAt: Date.parse(issue.created_at),
			url: issue.html_url,
			reference: `${repo.full_name}#${issue.number}`,
			comments: comments.get(issue.number) ?? [],
		};
	});
	return { name: "GitHub", issues, labelColors, pullRequests };
}

function toStatus(issue: GitHubIssue): IssueStatus {
	if (issue.state === "open") return "todo";
	return issue.state_reason === "not_planned" || issue.state_reason === "duplicate"
		? "canceled"
		: "done";
}

/** Every page of a list, following GitHub's `Link` header. */
async function* pages<T>(get: (url: string) => Promise<Response>, first: string) {
	let url: string | null = first;
	while (url) {
		const response = await get(url);
		yield (await response.json()) as T[];
		url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("Link") ?? "")?.[1] ?? null;
	}
}

async function request(url: string, token: string, options: ReadOptions): Promise<Response> {
	const response = await (options.fetch ?? fetch)(url, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(token && { Authorization: `Bearer ${token}` }),
		},
		signal: options.signal,
	});
	if (response.ok) return response;
	if (response.status === 401) throw new Error("GitHub did not accept the token.");
	if (
		(response.status === 403 || response.status === 429) &&
		response.headers.get("X-RateLimit-Remaining") === "0"
	) {
		const reset = Number(response.headers.get("X-RateLimit-Reset")) * 1000;
		const at = reset
			? ` after ${new Date(reset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
			: " later";
		throw new Error(
			`GitHub's limit on requests was reached. Try again${at}${token ? "" : ", or add a token"}.`,
		);
	}
	if (response.status === 404) {
		throw new Error(
			token
				? "GitHub has no such repository, or the token cannot read it."
				: "GitHub has no such public repository. For a private one, add a token that can read it.",
		);
	}
	throw new Error(`GitHub answered with an error (${response.status}). Try again later.`);
}
