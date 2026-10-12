ALTER TABLE `scheduled_runs` ADD `check_exit_code` integer;--> statement-breakpoint
ALTER TABLE `scheduled_runs` ADD `check_output` text;--> statement-breakpoint
ALTER TABLE `scheduled_runs` ADD `check_stderr` text;--> statement-breakpoint
ALTER TABLE `scheduled_runs` ADD `check_duration_ms` integer;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `check_script` text;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `check_timeout_seconds` integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `check_approved_at` integer;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `check_proposed_by` text;