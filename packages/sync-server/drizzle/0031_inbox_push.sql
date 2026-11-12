ALTER TABLE `inbox_items` ADD `push_at` integer;--> statement-breakpoint
CREATE INDEX `inbox_items_push_idx` ON `inbox_items` (`push_at`);