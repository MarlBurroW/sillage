CREATE TABLE `price_catalogs` (
	`source` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`etag` text,
	`fetched_at` integer NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turn_usage` (
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`model` text NOT NULL,
	`ts` integer NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`agent` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_1h_tokens` integer DEFAULT 0 NOT NULL,
	`reported_cost_usd` real,
	PRIMARY KEY(`conversation_id`, `seq`, `model`)
);
--> statement-breakpoint
CREATE INDEX `idx_turn_usage_ts` ON `turn_usage` (`ts`);