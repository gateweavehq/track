CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`lead_id` text,
	`target_date` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
ALTER TABLE `issues` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `issues_project_idx` ON `issues` (`project_id`);