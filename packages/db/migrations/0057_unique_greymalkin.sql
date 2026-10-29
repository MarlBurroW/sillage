CREATE TABLE `worktree_kept_files` (
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`fingerprint` text NOT NULL,
	`files` integer NOT NULL,
	`kept_by` text,
	`kept_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `path`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kept_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
