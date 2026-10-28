import type { Comment, Issue, Team } from "@gateweave/track-protocol";

/*
 * Full-text search over the browser's replica. The Durable Object indexes the same text for the
 * MCP `search_issues` tool, and both must agree on what matches, so the rules are shared:
 * normalize, split into letter/digit runs, and require every query token to be a prefix of some
 * token in the key, title, description or comments.
 */

export const FIELD_WEIGHTS = { key: 10, title: 10, description: 3, comments: 1 } as const;

type Field = keyof typeof FIELD_WEIGHTS;

export interface SearchResult {
	issue: Issue;
	score: number;
	/** A short excerpt, set when a word matched in the description or a comment, not the title. */
	snippet?: string;
}

export interface SearchTables {
	teams: ReadonlyMap<string, Team>;
	issues: ReadonlyMap<string, Issue>;
	comments: ReadonlyMap<string, Comment>;
}

/** Lowercase, without diacritics: "Résumé" and "İstanbul" become "resume" and "istanbul". */
export function normalize(text: string): string {
	return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Maximal runs of letters and digits, after normalizing. */
export function tokenize(text: string): string[] {
	return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Rows are replaced, never mutated, so a row's tokens stay valid for as long as the row lives.
const issueTokens = new WeakMap<Issue, { title: string[]; description: string[] }>();
const commentTokens = new WeakMap<Comment, string[]>();
const commentGroups = new WeakMap<ReadonlyMap<string, Comment>, Map<string, Comment[]>>();

function tokensOfIssue(issue: Issue) {
	let tokens = issueTokens.get(issue);
	if (!tokens) {
		tokens = { title: tokenize(issue.title), description: tokenize(issue.description ?? "") };
		issueTokens.set(issue, tokens);
	}
	return tokens;
}

function tokensOfComment(comment: Comment): string[] {
	let tokens = commentTokens.get(comment);
	if (!tokens) {
		tokens = tokenize(comment.body);
		commentTokens.set(comment, tokens);
	}
	return tokens;
}

function commentsByIssue(comments: ReadonlyMap<string, Comment>): Map<string, Comment[]> {
	let groups = commentGroups.get(comments);
	if (!groups) {
		groups = new Map();
		for (const comment of comments.values()) {
			const group = groups.get(comment.issueId);
			if (group) group.push(comment);
			else groups.set(comment.issueId, [comment]);
		}
		for (const group of groups.values()) group.sort((a, b) => a.createdAt - b.createdAt);
		commentGroups.set(comments, groups);
	}
	return groups;
}

function hasPrefix(tokens: readonly string[], prefix: string): boolean {
	for (const token of tokens) if (token.startsWith(prefix)) return true;
	return false;
}

const NO_COMMENTS: readonly Comment[] = [];

/** The field a query token matches best in, or null when it matches nowhere. */
function bestField(
	token: string,
	keyTokens: readonly string[],
	issue: Issue,
	comments: readonly Comment[],
): Field | null {
	if (hasPrefix(keyTokens, token)) return "key";
	const tokens = tokensOfIssue(issue);
	if (hasPrefix(tokens.title, token)) return "title";
	if (hasPrefix(tokens.description, token)) return "description";
	for (const comment of comments) if (hasPrefix(tokensOfComment(comment), token)) return "comments";
	return null;
}

/** Issues matching every word of `query`, best first. A query without words matches nothing. */
export function search(tables: SearchTables, query: string, limit = 20): SearchResult[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];
	const grouped = commentsByIssue(tables.comments);
	const matches: { issue: Issue; score: number; fields: Field[] }[] = [];

	for (const issue of tables.issues.values()) {
		const keyTokens = [normalize(tables.teams.get(issue.teamId)?.key ?? "?"), String(issue.number)];
		const comments = grouped.get(issue.id) ?? NO_COMMENTS;
		let score = 0;
		const fields: Field[] = [];
		for (const token of queryTokens) {
			const field = bestField(token, keyTokens, issue, comments);
			if (!field) break;
			score += FIELD_WEIGHTS[field];
			fields.push(field);
		}
		if (fields.length === queryTokens.length) matches.push({ issue, score, fields });
	}

	matches.sort((a, b) => b.score - a.score || b.issue.updatedAt - a.issue.updatedAt);
	return matches.slice(0, limit).map(({ issue, score, fields }) => {
		const result: SearchResult = { issue, score };
		const at = fields.findIndex((field) => field === "description" || field === "comments");
		const token = queryTokens[at];
		if (token !== undefined) {
			const snippet = findSnippet(issue, grouped.get(issue.id) ?? NO_COMMENTS, token, fields[at]);
			if (snippet) result.snippet = snippet;
		}
		return result;
	});
}

function findSnippet(
	issue: Issue,
	comments: readonly Comment[],
	token: string,
	field: Field | undefined,
): string | undefined {
	if (field === "description") return excerpt(issue.description ?? "", token);
	for (const comment of comments) {
		const found = excerpt(comment.body, token);
		if (found) return found;
	}
	return undefined;
}

const SNIPPET_LENGTH = 80;
const LEAD = 24;

/** About 80 characters around the first word that starts with `prefix`, cut at word boundaries. */
export function excerpt(text: string, prefix: string): string | undefined {
	const flat = text.replace(/\s+/g, " ").trim();
	// Words include combining marks, so "é" written as e + U+0301 stays one word.
	for (const word of flat.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
		if (!tokenize(word[0]).some((part) => part.startsWith(prefix))) continue;
		if (flat.length <= SNIPPET_LENGTH) return flat;
		const wordEnd = word.index + word[0].length;
		let start = Math.max(0, word.index - LEAD);
		let end = Math.min(flat.length, start + SNIPPET_LENGTH);
		start = Math.max(0, end - SNIPPET_LENGTH);
		// Move each cut to a space, but never past the matching word.
		if (start > 0) {
			const space = flat.indexOf(" ", start);
			if (space !== -1 && space < word.index) start = space + 1;
		}
		if (end < flat.length) {
			const space = flat.lastIndexOf(" ", end);
			if (space >= wordEnd) end = space;
		}
		const lead = start > 0 ? "…" : "";
		const tail = end < flat.length ? "…" : "";
		return `${lead}${flat.slice(start, end).trim()}${tail}`;
	}
	return undefined;
}
