CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`member_id` text NOT NULL,
	`event` text NOT NULL,
	`actor_id` text NOT NULL,
	`unread` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`snoozed_until` integer,
	`archived_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `inbox_items_issue_idx` ON `inbox_items` (`issue_id`);--> statement-breakpoint
CREATE INDEX `inbox_items_member_idx` ON `inbox_items` (`member_id`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`member_id` text NOT NULL,
	`subscribed` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscriptions_issue_idx` ON `subscriptions` (`issue_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_member_idx` ON `subscriptions` (`member_id`);--> statement-breakpoint
ALTER TABLE `oplog` ADD `audience` text;