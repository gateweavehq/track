CREATE TABLE `github_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_delivery_at` integer,
	`last_event` text,
	`last_repository` text
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`branch` text NOT NULL,
	`author` text,
	`issue_ids` text NOT NULL,
	`closing_issue_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `activities` ADD `source` text;