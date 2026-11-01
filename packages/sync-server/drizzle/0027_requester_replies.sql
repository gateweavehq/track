ALTER TABLE `requesters` ADD `reply_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `requesters_reply_key_unique` ON `requesters` (`reply_key`);