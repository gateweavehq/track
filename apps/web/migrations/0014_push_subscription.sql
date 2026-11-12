CREATE TABLE `push_subscription` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`saved_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pushSubscription_userId_idx` ON `push_subscription` (`user_id`);--> statement-breakpoint
CREATE INDEX `pushSubscription_sessionId_idx` ON `push_subscription` (`session_id`);