CREATE TABLE `due_reminders` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`due_on` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issues_due_idx` ON `issues` (`due_date`);