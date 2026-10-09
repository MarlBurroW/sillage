CREATE TABLE `project_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`command` text NOT NULL,
	`subdir` text,
	`url` text,
	`approved_at` integer,
	`agent_conversation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_actions_project` ON `project_actions` (`project_id`,`created_at`);