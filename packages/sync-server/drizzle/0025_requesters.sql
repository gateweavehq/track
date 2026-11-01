CREATE TABLE `requesters` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`notice` text,
	`reply` text,
	`created_at` integer NOT NULL
);
