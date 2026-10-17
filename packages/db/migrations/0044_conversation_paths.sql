CREATE TABLE `conversation_paths` (
	`conversation_id` text NOT NULL,
	`path` text NOT NULL,
	`last_ts` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `path`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `decisions` ADD `worktree_path` text;--> statement-breakpoint
-- Rattrapage unique : les éditions déjà journalisées hors du répertoire de travail
-- (chemin absolu) alimentent la table, pour que les chantiers existants soient
-- rattachés à leurs sessions sans attendre une nouvelle écriture.
INSERT INTO `conversation_paths` (`conversation_id`, `path`, `last_ts`)
SELECT `conversation_id`, `payload` ->> '$.path', max(`ts`)
FROM `events`
WHERE `type` = 'file.edited' AND substr(`payload` ->> '$.path', 1, 1) = '/'
GROUP BY `conversation_id`, `payload` ->> '$.path';
