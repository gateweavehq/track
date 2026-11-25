CREATE TABLE `panel_seats` (
	`panel_id` text NOT NULL,
	`member_id` text NOT NULL,
	`body` text,
	`submitted_at` integer,
	`alias` text,
	FOREIGN KEY (`panel_id`) REFERENCES `panels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `panel_seats_member` ON `panel_seats` (`panel_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `panels` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`opened_by` text NOT NULL,
	`deadline_at` integer NOT NULL,
	`opened_at` integer NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`revealed_at` integer,
	`reveal_reason` text,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `panels_state` ON `panels` (`state`);