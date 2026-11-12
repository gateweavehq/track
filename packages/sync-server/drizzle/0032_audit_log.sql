CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_label` text,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);