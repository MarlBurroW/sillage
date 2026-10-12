CREATE TABLE `board_links` (
	`project_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`repo` text NOT NULL,
	`user_id` text NOT NULL,
	`label_filter` text DEFAULT '' NOT NULL,
	`closed_days` integer DEFAULT 14 NOT NULL,
	`new_cards` text DEFAULT 'local' NOT NULL,
	`progress_label` text DEFAULT 'in progress' NOT NULL,
	`review_label` text DEFAULT 'review' NOT NULL,
	`on_issue` integer DEFAULT false NOT NULL,
	`issue_instructions` text DEFAULT '' NOT NULL,
	`on_comment` integer DEFAULT false NOT NULL,
	`comment_instructions` text DEFAULT '' NOT NULL,
	`comment_delivery` text DEFAULT 'queue' NOT NULL,
	`reply_style` text DEFAULT '' NOT NULL,
	`identity` text DEFAULT 'ai' NOT NULL,
	`signature` text DEFAULT '' NOT NULL,
	`session_agent` text DEFAULT 'claude' NOT NULL,
	`session_config` text,
	`workspace` text DEFAULT 'worktree' NOT NULL,
	`max_sessions_per_hour` integer DEFAULT 10 NOT NULL,
	`hidden_issues` text DEFAULT '[]' NOT NULL,
	`cursor` text,
	`last_synced_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `card_issues` (
	`card_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`author` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`marker` text,
	`state` text NOT NULL,
	`state_reason` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`remote_updated_at` text NOT NULL,
	`closed_at` integer,
	`detached` integer DEFAULT false NOT NULL,
	`responder_id` text,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_card_issues_number` ON `card_issues` (`project_id`,`provider`,`repo`,`number`);--> statement-breakpoint
ALTER TABLE `card_notes` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `card_notes` ADD `external_author` text;--> statement-breakpoint
ALTER TABLE `card_notes` ADD `external_url` text;--> statement-breakpoint
ALTER TABLE `card_notes` ADD `publication` text;--> statement-breakpoint
ALTER TABLE `card_notes` ADD `publication_error` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_card_notes_external` ON `card_notes` (`card_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_card_notes_publication` ON `card_notes` (`publication`);