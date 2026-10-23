CREATE TABLE `claude_transcript_cursors` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`journal_seq` integer NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
