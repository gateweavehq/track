CREATE TABLE `work_run_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `signals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_id`) REFERENCES `work_run_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_run_attempts_claim_idx` ON `work_run_attempts` (`request_id`,`claim_id`);--> statement-breakpoint
CREATE TABLE `work_run_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`assignment_version` integer NOT NULL,
	`runner_id` text NOT NULL,
	`repository` text NOT NULL,
	`source_id` text NOT NULL,
	`active_attempt_id` text,
	`last_attempt_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_run_requests_assignment_idx` ON `work_run_requests` (`issue_id`,`assignment_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_run_requests_active_idx` ON `work_run_requests` (`issue_id`) WHERE "work_run_requests"."active_attempt_id" IS NOT NULL;