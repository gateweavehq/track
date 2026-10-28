-- Full-text search over issues (src/search.ts). Drizzle cannot express an FTS5 table, so this
-- migration is written by hand. issue_search_docs gives each live issue a stable integer id for
-- its row in the index: an INTEGER PRIMARY KEY never changes, unlike the implicit rowid of a
-- table keyed by text, which VACUUM may renumber.
CREATE TABLE `issue_search_docs` (
	`id` integer PRIMARY KEY,
	`issue_id` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `issue_search` USING fts5(
	`key`,
	`title`,
	`description`,
	`comments`,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
INSERT INTO `issue_search_docs` (`issue_id`) SELECT `id` FROM `issues` WHERE `deleted_at` IS NULL;
--> statement-breakpoint
INSERT INTO `issue_search` (`rowid`, `key`, `title`, `description`, `comments`)
SELECT
	d.`id`,
	t.`key` || '-' || i.`number`,
	i.`title`,
	coalesce(i.`description`, ''),
	coalesce(
		(SELECT group_concat(c.`body`, char(10)) FROM `comments` c
			WHERE c.`issue_id` = i.`id` AND c.`deleted_at` IS NULL),
		''
	)
FROM `issue_search_docs` d
JOIN `issues` i ON i.`id` = d.`issue_id`
JOIN `teams` t ON t.`id` = i.`team_id`;
