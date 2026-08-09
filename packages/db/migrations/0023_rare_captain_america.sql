CREATE TABLE `card_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`conversation_id` text,
	`user_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_card_notes_card` ON `card_notes` (`card_id`,`created_at`);