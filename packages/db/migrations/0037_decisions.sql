CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_label` text NOT NULL,
	`task_id` text,
	`card_id` text,
	`question` text NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`default_option` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`answer_option` text,
	`answer_text` text,
	`answered_by` text,
	`resolved_at` integer,
	`withdrawn_reason` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_decisions_user_status` ON `decisions` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_decisions_conversation` ON `decisions` (`conversation_id`,`status`);--> statement-breakpoint
ALTER TABLE `board_links` ADD `decisions_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `board_links` ADD `decision_max_hours` integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `decisions_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `decision_max_hours` integer DEFAULT 24 NOT NULL;