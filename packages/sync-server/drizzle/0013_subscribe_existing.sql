-- Subscriptions began with the inbox. Issues made before then subscribe the people the inbox
-- would have: each live issue's creator, its assignee and whoever commented on it, if they are
-- still members and are not agents. Nobody's inbox gets anything for the past. Clients take
-- these from their next snapshot, which the protocol bump that brings the inbox asks for.
INSERT OR IGNORE INTO `subscriptions` (`id`, `issue_id`, `member_id`, `subscribed`, `updated_at`)
SELECT `people`.`issue_id` || '/' || `people`.`member_id`, `people`.`issue_id`, `people`.`member_id`, 1,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM (
	SELECT `id` AS `issue_id`, `creator_id` AS `member_id` FROM `issues` WHERE `deleted_at` IS NULL
	UNION
	SELECT `id`, `assignee_id` FROM `issues` WHERE `deleted_at` IS NULL AND `assignee_id` IS NOT NULL
	UNION
	SELECT `comments`.`issue_id`, `comments`.`author_id` FROM `comments`
	JOIN `issues` ON `issues`.`id` = `comments`.`issue_id`
	WHERE `comments`.`deleted_at` IS NULL AND `issues`.`deleted_at` IS NULL
) AS `people`
JOIN `members` ON `members`.`user_id` = `people`.`member_id`
WHERE `members`.`removed_at` IS NULL AND `members`.`role` != 'agent';
