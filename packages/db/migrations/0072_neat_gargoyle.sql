DROP INDEX `idx_worktrees_project_name`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_worktrees_project_name` ON `worktrees` (`project_id`,`name`) WHERE "worktrees"."removed_at" IS NULL;