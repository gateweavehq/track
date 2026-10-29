CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`change` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `proposals_issue_idx` ON `proposals` (`issue_id`,`status`);--> statement-breakpoint
ALTER TABLE `activities` ADD `proposed_by` text;--> statement-breakpoint
ALTER TABLE `members` ADD `proposes` text DEFAULT '[]' NOT NULL;