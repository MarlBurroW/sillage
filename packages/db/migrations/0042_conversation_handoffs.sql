CREATE TABLE `conversation_handoffs` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`from_conversation_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`budget_tokens` integer NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `handoff_from_id` text;