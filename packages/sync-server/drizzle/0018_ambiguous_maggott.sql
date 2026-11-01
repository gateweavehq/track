CREATE TABLE `statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`color` text,
	`sort_order` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statuses_team_key_idx` ON `statuses` (`team_id`,`key`);