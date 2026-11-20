CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`key` text NOT NULL,
	`type` text,
	`subject` text,
	`severity` text NOT NULL,
	`state` text NOT NULL,
	`url` text,
	`issue_id` text,
	`reopens` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	`changed_at` integer NOT NULL,
	`last_sent_at` integer NOT NULL,
	`cleared_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signals_source_key_idx` ON `signals` (`source_id`,`key`);--> statement-breakpoint
CREATE INDEX `signals_issue_idx` ON `signals` (`issue_id`);--> statement-breakpoint
CREATE INDEX `signals_retention_idx` ON `signals` (`state`,`cleared_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`product` text NOT NULL,
	`team_id` text NOT NULL,
	`assignee_id` text,
	`lowest_severity` text NOT NULL,
	`close_when_cleared` integer NOT NULL,
	`link_origins` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`removing` integer DEFAULT false NOT NULL,
	`last_heard_at` integer,
	`call_times` text DEFAULT '[]' NOT NULL,
	`usage` text DEFAULT '[]' NOT NULL,
	`last_refused_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
