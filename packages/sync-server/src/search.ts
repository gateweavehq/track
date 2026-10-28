import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Db } from "./state";

// Full-text search over a workspace's live issues: their key, title, description and comments.
// An FTS5 table (migration 0003) holds one row per issue, rebuilt from the source rows by every
// write that changes what it would contain, inside that write's transaction. Rebuilding instead
// of patching means the index cannot drift from the data.
//
// Matching follows the same rules as the browser's search (apps/web/src/lib/search.ts): text is
// folded to lowercase without diacritics, split into runs of letters and digits, and an issue
// matches when every word of the query starts a word in one of its fields.

// For queries only. These live outside db/schema.ts, so Drizzle Kit leaves them to migration 0003.

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

/** Puts a live issue's current key, title, description and comments in the index. */
export function indexIssue(db: Db, issueId: string): void {
	db.run(
		sql`insert into issue_search_docs (issue_id) values (${issueId}) on conflict (issue_id) do nothing`,
	);
	const doc = db.get<{ id: number } | undefined>(
		sql`select id from issue_search_docs where issue_id = ${issueId}`,
	);
	if (!doc) return;
	db.run(sql`delete from issue_search where rowid = ${doc.id}`);
	db.run(sql`
		insert into issue_search (rowid, key, title, description, comments)
		select ${doc.id}, t.key || '-' || i.number, i.title, coalesce(i.description, ''),
			coalesce(
				(select group_concat(c.body, char(10)) from comments c
					where c.issue_id = i.id and c.deleted_at is null),
				''
			)
		from issues i join teams t on t.id = i.team_id
		where i.id = ${issueId} and i.deleted_at is null
	`);
}

/** Takes a deleted issue out of the index. */
export function unindexIssue(db: Db, issueId: string): void {
	const doc = db.get<{ id: number } | undefined>(
		sql`select id from issue_search_docs where issue_id = ${issueId}`,
	);
	if (!doc) return;
	db.run(sql`delete from issue_search where rowid = ${doc.id}`);
	db.run(sql`delete from issue_search_docs where id = ${doc.id}`);
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

/** Orders matches best first, for queries that filter with `matches`. */
export const RANK = sql`bm25(${issueSearch}, ${WEIGHTS})`;
