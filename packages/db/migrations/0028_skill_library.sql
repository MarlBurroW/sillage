CREATE TABLE `library_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_id` text,
	`source_path` text,
	`source_commit` text,
	`installed_hash` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `skill_sources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_library_skills_project` ON `library_skills` (`project_id`);--> statement-breakpoint
CREATE TABLE `skill_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`ref` text,
	`subpath` text,
	`builtin` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_commit` text,
	`last_fetched_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Sources préconfigurées, insérées ici et non au démarrage : une source que l'admin
-- supprime ne doit pas revenir au redémarrage suivant. `.system` d'openai/skills est
-- laissé de côté, Codex embarquant déjà ces skills.
INSERT INTO `skill_sources` (`id`, `name`, `url`, `ref`, `subpath`, `builtin`, `enabled`, `created_at`, `updated_at`)
VALUES
  ('builtin:anthropics-skills', 'anthropics/skills', 'https://github.com/anthropics/skills.git', NULL, 'skills', 1, 1,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('builtin:openai-skills', 'openai/skills', 'https://github.com/openai/skills.git', NULL, 'skills/.curated', 1, 1,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
