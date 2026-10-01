CREATE TABLE `session_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_conversation_id` text NOT NULL,
	`to_conversation_id` text NOT NULL,
	`kind` text DEFAULT 'message' NOT NULL,
	`body` text NOT NULL,
	`reply_to` text,
	`created_at` integer NOT NULL,
	`held_at` integer,
	`delivered_at` integer,
	`delivered_via` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_messages_to` ON `session_messages` (`to_conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_session_messages_pending` ON `session_messages` (`delivered_at`);--> statement-breakpoint
CREATE TABLE `session_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`watcher_conversation_id` text NOT NULL,
	`target_conversation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`fired_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_watches_open` ON `session_watches` (`fired_at`);