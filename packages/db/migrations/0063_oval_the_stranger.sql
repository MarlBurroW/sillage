CREATE TABLE `usage_limit_resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`resets_at` integer,
	`resume_at` integer,
	`status` text NOT NULL,
	`reason` text,
	`message` text,
	`superseded_at` integer,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_usage_limit_resumes_status` ON `usage_limit_resumes` (`status`,`resume_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_limit_resumes_conversation` ON `usage_limit_resumes` (`conversation_id`,`created_at`);