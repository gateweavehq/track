CREATE TABLE `source_key` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`hash` text NOT NULL,
	`start` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_key_hash_unique` ON `source_key` (`hash`);--> statement-breakpoint
CREATE INDEX `sourceKey_workspace_source_idx` ON `source_key` (`organization_id`,`source_id`);