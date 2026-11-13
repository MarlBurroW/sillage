CREATE TABLE `conversation_project_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`from_project_id` text NOT NULL,
	`to_project_id` text NOT NULL,
	`from_cwd` text NOT NULL,
	`through_seq` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`error` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_project_moves_history` ON `conversation_project_moves` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_conversation_project_moves_pending` ON `conversation_project_moves` (`conversation_id`) WHERE "conversation_project_moves"."completed_at" IS NULL;