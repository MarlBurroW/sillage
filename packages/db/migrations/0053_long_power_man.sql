CREATE TABLE `thread_projection_rows` (
	`conversation_id` text NOT NULL,
	`category` text NOT NULL,
	`position` integer NOT NULL,
	`entry_key` text NOT NULL,
	`item_kind` text NOT NULL,
	`related` text,
	`live` integer NOT NULL,
	`updated_seq` integer NOT NULL,
	`bytes` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `category`, `position`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_thread_projection_key` ON `thread_projection_rows` (`conversation_id`,`category`,`entry_key`);--> statement-breakpoint
CREATE INDEX `idx_thread_projection_live` ON `thread_projection_rows` (`conversation_id`,`live`);--> statement-breakpoint
CREATE INDEX `idx_thread_projection_updated` ON `thread_projection_rows` (`conversation_id`,`updated_seq`);--> statement-breakpoint
CREATE INDEX `idx_thread_projection_related` ON `thread_projection_rows` (`conversation_id`,`related`);--> statement-breakpoint
CREATE INDEX `idx_thread_projection_kind` ON `thread_projection_rows` (`conversation_id`,`item_kind`,`position`);--> statement-breakpoint
CREATE TABLE `thread_projections` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`cursor` integer NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
