CREATE TABLE `benchmark_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_benchmark_presets_user_key` ON `benchmark_presets` (`user_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `benchmark_shares` ADD `options` text;--> statement-breakpoint
ALTER TABLE `benchmark_shares` ADD `refreshed_at` integer;--> statement-breakpoint
ALTER TABLE `benchmarks` ADD `comparisons` text;