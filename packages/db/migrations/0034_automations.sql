CREATE TABLE `automation_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`delivery_id` text,
	`headers` text NOT NULL,
	`query` text DEFAULT '{}' NOT NULL,
	`body` text NOT NULL,
	`bytes` integer NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`verdict` text NOT NULL,
	`reason` text,
	`subject` text,
	`vars` text,
	`summary` text,
	`run_id` text,
	`conversation_id` text,
	`origin_conversation_id` text,
	FOREIGN KEY (`task_id`) REFERENCES `scheduled_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_automation_deliveries_task` ON `automation_deliveries` (`task_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_automation_deliveries_queue` ON `automation_deliveries` (`verdict`,`received_at`);--> statement-breakpoint
CREATE TABLE `automation_webhooks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`secret` text NOT NULL,
	`verification` text NOT NULL,
	`delivery_header` text DEFAULT '' NOT NULL,
	`conditions` text NOT NULL,
	`script` text DEFAULT '' NOT NULL,
	`subject_path` text DEFAULT '' NOT NULL,
	`marker_paths` text DEFAULT '*' NOT NULL,
	`max_runs_per_hour` integer NOT NULL,
	`tripped_at` integer,
	`template` text,
	FOREIGN KEY (`task_id`) REFERENCES `scheduled_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_automation_webhooks_token` ON `automation_webhooks` (`token`);