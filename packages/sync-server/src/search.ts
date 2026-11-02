import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Db } from "./state";

// Full-text search over a workspace's live issues: their key, title, description and comments.
// An FTS5 table (migration 0003) holds one row per issue, rebuilt from the source rows by every
// write that changes what it would contain, inside that write's transaction. Rebuilding instead
// of patching means the index cannot drift from the data.
//
// A row is one value per column, and SQLite refuses a value past its length limit, so an issue
// whose comments outgrow `INLINE_COMMENT_BYTES` keeps none of them in its row: each live comment
// gets a row of its own in a second FTS5 table (migration 0029), rebuilt from that comment by the
// write that changes it. Issues under the limit, nearly all of them, are indexed and ranked as
// they always were; see `commentMatches` for how the others are found.
//
// Matching follows the same rules as the browser's search (apps/web/src/lib/search.ts): text is
// folded to lowercase without diacritics, split into runs of letters and digits, and an issue
// matches when every word of the query starts a word in one of its fields.

// For queries only. These live outside db/schema.ts, so Drizzle Kit leaves them to migrations
// 0003 and 0029.

/** Each indexed issue's row id in `issueSearch`. */
export const issueSearchDocs = sqliteTable("issue_search_docs", {
	id: integer("id").primaryKey(),
	issueId: text("issue_id").notNull(),
});

/** The FTS5 table. `rowid` is `issueSearchDocs.id`. */
export const issueSearch = sqliteTable("issue_search", {
	rowid: integer("rowid").notNull(),
	key: text("key").notNull(),
	title: text("title").notNull(),
	description: text("description").notNull(),
	comments: text("comments").notNull(),
});

/** Index weights for bm25, in column order: key, title, description, comments. */
const WEIGHTS = sql.raw("10.0, 10.0, 3.0, 1.0");

/**
 * The most comment text, in UTF-8 bytes with a separator for each comment, that an issue's row
 * holds. Well under SQLite's limit on a value (about 10 MB) and Cloudflare's on a row (2 MB),
 * with room for the longest title and description. Migration 0029 spells it out.
 */
export const INLINE_COMMENT_BYTES = 1024 * 1024;

/** Puts a live issue's current key, title, description and comments in the index. */
export function indexIssue(db: Db, issueId: string): void {
	const live = db.get<{ id: string } | undefined>(
		sql`select id from issues where id = ${issueId} and deleted_at is null`,
	);
	if (!live) {
		unindexIssue(db, issueId);
		return;
	}
	db.run(
		sql`insert into issue_search_docs (issue_id) values (${issueId}) on conflict (issue_id) do nothing`,
	);
	const doc = db.get<{ id: number } | undefined>(
		sql`select id from issue_search_docs where issue_id = ${issueId}`,
	);
	if (!doc) return;
	// octet_length reads each comment's size without reading its text.
	const size = db.get<{ bytes: number }>(sql`
		select coalesce(sum(octet_length(body) + 1), 0) as bytes from comments
		where issue_id = ${issueId} and deleted_at is null
	`);
	const apart = (size?.bytes ?? 0) > INLINE_COMMENT_BYTES;
	const comments = apart
		? sql`''`
		: sql`coalesce(
				(select group_concat(c.body, char(10)) from comments c
					where c.issue_id = i.id and c.deleted_at is null),
				''
			)`;
	db.run(sql`delete from issue_search where rowid = ${doc.id}`);
	db.run(sql`
		insert into issue_search (rowid, key, title, description, comments)
		select ${doc.id}, t.key || '-' || i.number, i.title, coalesce(i.description, ''), ${comments}
		from issues i join teams t on t.id = i.team_id
		where i.id = ${issueId}
	`);
	if (!apart) {
		unindexComments(db, issueId);
		return;
	}
	// `indexComment` keeps each comment's row as it is written. Rebuild them all when the issue
	// first goes past the limit, or when a write that bypassed it left the count behind.
	const counts = db.get<{ indexed: number; live: number }>(sql`
		select
			(select count(*) from issue_comment_search_docs where issue_id = ${issueId}) as indexed,
			(select count(*) from comments where issue_id = ${issueId} and deleted_at is null) as live
	`);
	if (counts && counts.indexed === counts.live) return;
	unindexComments(db, issueId);
	db.run(sql`
		insert into issue_comment_search_docs (comment_id, issue_id)
		select id, issue_id from comments where issue_id = ${issueId} and deleted_at is null
	`);
	db.run(sql`
		insert into issue_comment_search (rowid, body)
		select d.id, c.body from issue_comment_search_docs d join comments c on c.id = d.comment_id
		where d.issue_id = ${issueId}
	`);
}

/**
 * Puts a comment's current text in the index, after it is created, edited or deleted: in its own
 * row when its issue's comments are indexed apart, and in its issue's row.
 */
export function indexComment(db: Db, comment: { id: string; issueId: string }): void {
	const apart = db.get<{ id: number } | undefined>(
		sql`select id from issue_comment_search_docs where issue_id = ${comment.issueId} limit 1`,
	);
	if (apart) {
		db.run(sql`
			insert into issue_comment_search_docs (comment_id, issue_id)
			values (${comment.id}, ${comment.issueId}) on conflict (comment_id) do nothing
		`);
		const doc = db.get<{ id: number } | undefined>(
			sql`select id from issue_comment_search_docs where comment_id = ${comment.id}`,
		);
		if (doc) {
			db.run(sql`delete from issue_comment_search where rowid = ${doc.id}`);
			const row = db.get<{ body: string } | undefined>(
				sql`select body from comments where id = ${comment.id} and deleted_at is null`,
			);
			if (row) {
				db.run(sql`insert into issue_comment_search (rowid, body) values (${doc.id}, ${row.body})`);
			} else db.run(sql`delete from issue_comment_search_docs where id = ${doc.id}`);
		}
	}
	indexIssue(db, comment.issueId);
}

/** Takes a deleted issue out of the index. */
export function unindexIssue(db: Db, issueId: string): void {
	unindexComments(db, issueId);
	const doc = db.get<{ id: number } | undefined>(
		sql`select id from issue_search_docs where issue_id = ${issueId}`,
	);
	if (!doc) return;
	db.run(sql`delete from issue_search where rowid = ${doc.id}`);
	db.run(sql`delete from issue_search_docs where id = ${doc.id}`);
}

/** Drops the rows of an issue's comments indexed apart, if it has any. */
function unindexComments(db: Db, issueId: string): void {
	db.run(sql`
		delete from issue_comment_search where rowid in
			(select id from issue_comment_search_docs where issue_id = ${issueId})
	`);
	db.run(sql`delete from issue_comment_search_docs where issue_id = ${issueId}`);
}

/** Reindexes a team's live issues, whose keys change with the team's. */
export function indexTeamIssues(db: Db, teamId: string): void {
	const issues = db.all<{ id: string }>(
		sql`select id from issues where team_id = ${teamId} and deleted_at is null`,
	);
	for (const { id } of issues) indexIssue(db, id);
}

/** Lowercase, without diacritics: "Résumé" becomes "resume", "İstanbul" becomes "istanbul". */
export function normalize(text: string): string {
	return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a text: runs of letters and digits, normalized. */
export function tokenize(text: string): string[] {
	return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * An FTS5 query where every word must start a word in the issue, or undefined when the text has
 * no words. Tokens are letters and digits only, so quoting them leaves no FTS5 syntax to inject.
 */
export function matchExpression(text: string): string | undefined {
	const words = tokenize(text);
	if (words.length === 0) return undefined;
	return words.map((word) => `"${word}"*`).join(" ");
}

/** Keeps the rows of `issueSearch` that match an expression from `matchExpression`. */
export function matches(expression: string) {
	return sql`${issueSearch} match ${expression}`;
}

/** Orders matches best first, for queries that filter with `matches`. Lower is better. */
export const RANK = sql<number>`bm25(${issueSearch}, ${WEIGHTS})`;

/**
 * The issues whose comments are indexed apart that match `text` only with their comments' help,
 * by their issues' ids, each with a rank: lower is better. An issue whose own row matches every
 * word is left out, as `matches` finds it.
 *
 * Every word must start a word in the issue's row or in one of its comments, as if they were one
 * row. bm25 scores a row by adding up what each word contributes, so the rank adds up each word's
 * best score among the issue's row and its comments. The comments' scores come from their own
 * table, so ranks compare among these issues only.
 */
export function commentMatches(db: Db, text: string): Map<string, number> {
	const found = new Map<string, number>();
	const words = [...new Set(tokenize(text))].map((word) => `"${word}"*`);
	if (words.length === 0) return found;
	// The comments that match any word, and their issues' rows. Usually none: only issues past
	// the limit have comments here.
	const comments = db.all<{ doc: number; issueId: string; issueDoc: number }>(sql`
		select d.id as doc, d.issue_id as issueId, i.id as issueDoc
		from issue_comment_search
		join issue_comment_search_docs d on d.id = issue_comment_search.rowid
		join issue_search_docs i on i.issue_id = d.issue_id
		where issue_comment_search match ${words.join(" OR ")}
	`);
	if (comments.length === 0) return found;
	const issueOf = new Map(comments.map((comment) => [comment.doc, comment.issueId]));
	const issueDocs = new Map(comments.map((comment) => [comment.issueId, comment.issueDoc]));

	// Each issue's best score for each word, from its comments, then from its own row. FTS5
	// scores only in a query of the table it matches, so these are plain queries of one table.
	const best = new Map<string, number[]>();
	const ownOnly = new Map<string, boolean>();
	for (const issueId of issueDocs.keys()) {
		best.set(
			issueId,
			words.map(() => Number.POSITIVE_INFINITY),
		);
		ownOnly.set(issueId, true);
	}
	words.forEach((word, w) => {
		const scored = db.all<{ doc: number; score: number }>(sql`
			select rowid as doc, bm25(issue_comment_search) as score from issue_comment_search
			where issue_comment_search match ${word}
		`);
		for (const { doc, score } of scored) {
			const scores = best.get(issueOf.get(doc) ?? "");
			if (scores) scores[w] = Math.min(scores[w] ?? score, score);
		}
	});
	for (const [issueId, issueDoc] of issueDocs) {
		const scores = best.get(issueId);
		if (!scores) continue;
		words.forEach((word, w) => {
			// The Durable Object binds a number as a real, and FTS5 drops a rowid constraint that is
			// not an integer when it also matches, so the cast keeps this to the issue's row.
			const own = db.get<{ score: number } | undefined>(sql`
				select ${RANK} as score from ${issueSearch}
				where ${matches(word)} and rowid = cast(${issueDoc} as integer)
			`);
			if (own) scores[w] = Math.min(scores[w] ?? own.score, own.score);
			else ownOnly.set(issueId, false);
		});
		const rank = scores.reduce((sum, score) => sum + score, 0);
		if (!ownOnly.get(issueId) && Number.isFinite(rank)) found.set(issueId, rank);
	}
	return found;
}
