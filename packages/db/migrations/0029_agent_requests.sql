CREATE TABLE `agent_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`result` text,
	`is_error` integer DEFAULT false NOT NULL,
	`launched_conversation_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_requests_pending` ON `agent_requests` (`settled_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_requests_from` ON `agent_requests` (`conversation_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_requests_launched` ON `agent_requests` (`launched_conversation_id`);