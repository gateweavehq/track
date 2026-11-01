ALTER TABLE `issues` ADD `intake` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `intake_form_key` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `intake_email_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_intake_form_key_unique` ON `teams` (`intake_form_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_intake_email_key_unique` ON `teams` (`intake_email_key`);