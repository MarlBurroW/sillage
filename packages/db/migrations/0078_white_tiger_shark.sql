CREATE TABLE `preview_labels` (
	`conversation_id` text NOT NULL,
	`port` integer NOT NULL,
	`title` text,
	`hidden` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `port`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
