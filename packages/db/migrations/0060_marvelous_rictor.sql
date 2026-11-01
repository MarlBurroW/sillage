CREATE TABLE `benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`benchmark_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`repetition` integer NOT NULL,
	`conversation_id` text,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`cli_version` text,
	`metrics` text,
	`response` text,
	`check` text,
	`files` text,
	`preview_token` text,
	`rating` integer,
	`rating_note` text,
	`rated_at` integer,
	FOREIGN KEY (`benchmark_id`) REFERENCES `benchmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_benchmark_runs_benchmark` ON `benchmark_runs` (`benchmark_id`,`variant_id`,`repetition`);--> statement-breakpoint
CREATE INDEX `idx_benchmark_runs_open` ON `benchmark_runs` (`status`);--> statement-breakpoint
CREATE TABLE `benchmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`variants` text NOT NULL,
	`repetitions` integer DEFAULT 1 NOT NULL,
	`concurrency` text DEFAULT 'sequential' NOT NULL,
	`max_duration_minutes` integer NOT NULL,
	`inputs` text DEFAULT '[]' NOT NULL,
	`check_script` text,
	`check_timeout_seconds` integer DEFAULT 120 NOT NULL,
	`series_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_benchmarks_user` ON `benchmarks` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_benchmarks_series` ON `benchmarks` (`series_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `benchmark_id` text;--> statement-breakpoint
CREATE INDEX `idx_conversations_benchmark` ON `conversations` (`benchmark_id`);