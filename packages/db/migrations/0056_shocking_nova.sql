CREATE TABLE `personal_memory_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`file` text NOT NULL,
	`before` text,
	`after` text,
	`conversation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_personal_memory_changes_user` ON `personal_memory_changes` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `personal_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`conversation_id` text NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`result` text,
	`is_error` integer DEFAULT false NOT NULL,
	`launched_conversation_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_agent_requests`("id", "project_id", "conversation_id", "user_id", "kind", "payload", "created_at", "settled_at", "result", "is_error", "launched_conversation_id") SELECT "id", "project_id", "conversation_id", "user_id", "kind", "payload", "created_at", "settled_at", "result", "is_error", "launched_conversation_id" FROM `agent_requests`;--> statement-breakpoint
DROP TABLE `agent_requests`;--> statement-breakpoint
ALTER TABLE `__new_agent_requests` RENAME TO `agent_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_agent_requests_pending` ON `agent_requests` (`settled_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_requests_from` ON `agent_requests` (`conversation_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_requests_launched` ON `agent_requests` (`launched_conversation_id`);--> statement-breakpoint
CREATE TABLE `__new_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`workspace_id` text,
	`worktree_id` text,
	`card_id` text,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`title_set_by_user` integer DEFAULT false NOT NULL,
	`title_set_by_agent` integer DEFAULT false NOT NULL,
	`agent` text NOT NULL,
	`agent_session_id` text,
	`forked_from_id` text,
	`handoff_from_id` text,
	`created_by_token_id` text,
	`origin_label` text,
	`schedule_id` text,
	`config` text NOT NULL,
	`status` text NOT NULL,
	`background_count` integer DEFAULT 0 NOT NULL,
	`loop_count` integer DEFAULT 0 NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`last_notable_seq` integer DEFAULT 0 NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`journal_bytes` integer DEFAULT 0 NOT NULL,
	`context_used_tokens` integer,
	`context_max_tokens` integer,
	`model` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `personal_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_conversations`("id", "project_id", "workspace_id", "worktree_id", "card_id", "user_id", "title", "title_set_by_user", "title_set_by_agent", "agent", "agent_session_id", "forked_from_id", "handoff_from_id", "created_by_token_id", "origin_label", "schedule_id", "config", "status", "background_count", "loop_count", "last_seq", "last_notable_seq", "turn_count", "journal_bytes", "context_used_tokens", "context_max_tokens", "model", "cost_usd", "input_tokens", "output_tokens", "pinned", "position", "archived_at", "created_at", "updated_at") SELECT "id", "project_id", NULL, "worktree_id", "card_id", "user_id", "title", "title_set_by_user", "title_set_by_agent", "agent", "agent_session_id", "forked_from_id", "handoff_from_id", "created_by_token_id", "origin_label", "schedule_id", "config", "status", "background_count", "loop_count", "last_seq", "last_notable_seq", "turn_count", "journal_bytes", "context_used_tokens", "context_max_tokens", "model", "cost_usd", "input_tokens", "output_tokens", "pinned", "position", "archived_at", "created_at", "updated_at" FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `__new_conversations` RENAME TO `conversations`;--> statement-breakpoint
CREATE INDEX `idx_conversations_project` ON `conversations` (`project_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_conversations_user` ON `conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_schedule` ON `conversations` (`schedule_id`);