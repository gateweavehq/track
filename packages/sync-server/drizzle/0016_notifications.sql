CREATE TABLE `notification_settings` (
	`member_id` text PRIMARY KEY NOT NULL,
	`levels` text NOT NULL,
	`emailed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `email_at` integer;--> statement-breakpoint
CREATE INDEX `inbox_items_email_idx` ON `inbox_items` (`email_at`);