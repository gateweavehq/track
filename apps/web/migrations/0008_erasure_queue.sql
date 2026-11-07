DROP INDEX `pendingErasure_createdAt_idx`;--> statement-breakpoint
ALTER TABLE `pending_erasure` ADD `last_tried_at` integer;--> statement-breakpoint
CREATE INDEX `pendingErasure_lastTriedAt_idx` ON `pending_erasure` (`last_tried_at`,`created_at`);