CREATE TABLE `cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`number` integer NOT NULL,
	`name` text,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cycles_team_number_idx` ON `cycles` (`team_id`,`number`);--> statement-breakpoint
ALTER TABLE `issues` ADD `cycle_id` text;--> statement-breakpoint
CREATE INDEX `issues_cycle_idx` ON `issues` (`cycle_id`);--> statement-breakpoint
ALTER TABLE `teams` ADD `cycles` text;