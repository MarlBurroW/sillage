CREATE TABLE `card_tag_links` (
	`card_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`card_id`, `tag_id`),
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `card_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_card_tag_links_tag` ON `card_tag_links` (`tag_id`);--> statement-breakpoint
CREATE TABLE `card_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`color` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_by_conversation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_card_tags_project_key` ON `card_tags` (`project_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `projects` ADD `agent_card_tags` integer DEFAULT true NOT NULL;