CREATE TABLE `relations` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`issue_id` text NOT NULL,
	`related_issue_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`related_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `relations_issue_idx` ON `relations` (`issue_id`);--> statement-breakpoint
CREATE INDEX `relations_related_issue_idx` ON `relations` (`related_issue_id`);