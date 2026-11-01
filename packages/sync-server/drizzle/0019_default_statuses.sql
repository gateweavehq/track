-- Teams got statuses of their own. Every team made before then gets the six statuses all teams
-- had, under the same keys, so its issues, their history and saved views keep their statuses.
-- Mirrors DEFAULT_STATUSES in packages/protocol/src/statuses.ts. Clients take these from their
-- next snapshot, which the protocol bump that brings statuses asks for. One statement per status:
-- Durable Objects allow few terms in a compound SELECT.
INSERT OR IGNORE INTO `statuses` (`id`, `team_id`, `key`, `name`, `category`, `color`, `sort_order`, `created_at`, `updated_at`, `removed_at`)
SELECT `id` || '/backlog', `id`, 'backlog', 'Backlog', 'backlog', NULL, 'a0',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM `teams`;
--> statement-breakpoint
INSERT OR IGNORE INTO `statuses` (`id`, `team_id`, `key`, `name`, `category`, `color`, `sort_order`, `created_at`, `updated_at`, `removed_at`)
SELECT `id` || '/todo', `id`, 'todo', 'Todo', 'unstarted', NULL, 'a0',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM `teams`;
--> statement-breakpoint
INSERT OR IGNORE INTO `statuses` (`id`, `team_id`, `key`, `name`, `category`, `color`, `sort_order`, `created_at`, `updated_at`, `removed_at`)
SELECT `id` || '/in_progress', `id`, 'in_progress', 'In Progress', 'started', '#f59e0b', 'a0',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM `teams`;
--> statement-breakpoint
INSERT OR IGNORE INTO `statuses` (`id`, `team_id`, `key`, `name`, `category`, `color`, `sort_order`, `created_at`, `updated_at`, `removed_at`)
SELECT `id` || '/in_review', `id`, 'in_review', 'In Review', 'started', '#10b981', 'a1',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM `teams`;
--> statement-breakpoint
INSERT OR IGNORE INTO `statuses` (`id`, `team_id`, `key`, `name`, `category`, `color`, `sort_order`, `created_at`, `updated_at`, `removed_at`)
SELECT `id` || '/done', `id`, 'done', 'Done', 'completed', '#6366f1', 'a0',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM `teams`;
--> statement-breakpoint
INSERT OR IGNORE INTO `statuses` (`id`, `team_id`, `key`, `name`, `category`, `color`, `sort_order`, `created_at`, `updated_at`, `removed_at`)
SELECT `id` || '/canceled', `id`, 'canceled', 'Canceled', 'canceled', NULL, 'a0',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM `teams`;
