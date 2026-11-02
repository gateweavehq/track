-- Comment search for issues whose comments outgrow their row in issue_search (src/search.ts).
-- That row held every comment in one value, and SQLite refuses a value past its length limit
-- (SQLITE_TOOBIG), so once an issue's comments came to about 10 MB no comment could be added to
-- it. Past 1 MiB of comment text, an issue's row now holds none of it, and each of its live
-- comments has a row of its own here instead. Written by hand, as Drizzle cannot express FTS5.
CREATE TABLE `issue_comment_search_docs` (
	`id` integer PRIMARY KEY,
	`comment_id` text NOT NULL UNIQUE,
	`issue_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issue_comment_search_docs_issue_idx` ON `issue_comment_search_docs` (`issue_id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `issue_comment_search` USING fts5(
	`body`,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
-- Only the issues past the limit change, so a workspace of ordinary issues rewrites nothing.
-- octet_length reads each comment's size without its text.
INSERT INTO `issue_comment_search_docs` (`comment_id`, `issue_id`)
SELECT c.`id`, c.`issue_id`
FROM `comments` c
JOIN `issue_search_docs` d ON d.`issue_id` = c.`issue_id`
WHERE c.`deleted_at` IS NULL
	AND c.`issue_id` IN (
		SELECT `issue_id` FROM `comments`
		WHERE `deleted_at` IS NULL
		GROUP BY `issue_id`
		HAVING sum(octet_length(`body`) + 1) > 1048576
	);
--> statement-breakpoint
INSERT INTO `issue_comment_search` (`rowid`, `body`)
SELECT cd.`id`, c.`body`
FROM `issue_comment_search_docs` cd
JOIN `comments` c ON c.`id` = cd.`comment_id`;
--> statement-breakpoint
UPDATE `issue_search` SET `comments` = ''
WHERE `rowid` IN (
	SELECT d.`id` FROM `issue_search_docs` d
	WHERE EXISTS (
		SELECT 1 FROM `issue_comment_search_docs` cd WHERE cd.`issue_id` = d.`issue_id`
	)
);
