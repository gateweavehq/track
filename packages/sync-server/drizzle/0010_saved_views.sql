CREATE TABLE `views` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text,
	`layout` text NOT NULL,
	`filters` text NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
