CREATE TABLE `api_task_options` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`webhook_url` text,
	`reply_deadline_sec` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`url` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`delivered_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_due` ON `webhook_deliveries` (`delivered_at`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `webhook_url` text;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `webhook_secret` text;