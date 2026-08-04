CREATE TABLE `conversation_reads` (
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Rattrapage écrit à la main : une table vide signifie « jamais ouvert », donc sans
-- cette ligne toute conversation antérieure à la migration s'allumerait en non lu au
-- premier démarrage. Chaque lecteur repart d'ici avec son historique déjà vu.
INSERT INTO `conversation_reads` (`conversation_id`, `user_id`, `last_read_seq`, `updated_at`)
SELECT `c`.`id`, `u`.`id`, `c`.`last_seq`, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `conversations` AS `c`
JOIN `projects` AS `p` ON `p`.`id` = `c`.`project_id`
JOIN `users` AS `u` ON `u`.`id` = `p`.`owner_id` OR `p`.`visibility` = 'shared';
