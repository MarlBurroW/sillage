CREATE TABLE `api_idempotency` (
	`token_id` text NOT NULL,
	`key` text NOT NULL,
	`conversation_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`token_id`, `key`),
	FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`hint` text NOT NULL,
	`label` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`project_ids` text NOT NULL,
	`agent` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_api_tokens_user` ON `api_tokens` (`user_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `created_by_token_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `origin_label` text;