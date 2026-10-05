CREATE TABLE `instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`content` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	`updated_by_conversation_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `instructions_mode` text;