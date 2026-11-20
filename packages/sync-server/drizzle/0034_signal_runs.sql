DROP INDEX `signals_source_key_idx`;--> statement-breakpoint
ALTER TABLE `signals` ADD `kind` text DEFAULT 'alert' NOT NULL;--> statement-breakpoint
ALTER TABLE `signals` ADD `progress` text;--> statement-breakpoint
ALTER TABLE `signals` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `signals` ADD `ended_at` integer;--> statement-breakpoint
ALTER TABLE `signals` ADD `executor` text;--> statement-breakpoint
ALTER TABLE `signals` ADD `agent_name` text;--> statement-breakpoint
ALTER TABLE `signals` ADD `wait_reason` text;--> statement-breakpoint
ALTER TABLE `signals` ADD `wait_detail` text;--> statement-breakpoint
ALTER TABLE `signals` ADD `last_contact_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `signals_source_kind_key_idx` ON `signals` (`source_id`,`kind`,`key`);