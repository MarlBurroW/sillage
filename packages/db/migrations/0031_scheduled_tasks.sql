CREATE TABLE `scheduled_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`conversation_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	`summary` text,
	FOREIGN KEY (`task_id`) REFERENCES `scheduled_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_runs_task` ON `scheduled_runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_runs_open` ON `scheduled_runs` (`status`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`agent` text NOT NULL,
	`config` text NOT NULL,
	`prompt` text NOT NULL,
	`cadence` text NOT NULL,
	`execution_mode` text DEFAULT 'fresh' NOT NULL,
	`overlap_policy` text DEFAULT 'skip' NOT NULL,
	`max_duration_minutes` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_conversation_id` text,
	`last_run_at` integer,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_project` ON `scheduled_tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_due` ON `scheduled_tasks` (`enabled`,`next_run_at`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `schedule_id` text;--> statement-breakpoint
CREATE INDEX `idx_conversations_schedule` ON `conversations` (`schedule_id`);