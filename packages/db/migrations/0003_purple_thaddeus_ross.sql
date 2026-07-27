DROP INDEX `idx_conversations_project`;--> statement-breakpoint
ALTER TABLE `conversations` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_conversations_project` ON `conversations` (`project_id`,`position`);--> statement-breakpoint
-- Remplissage : la position reprend l'ordre affiché jusqu'ici (plus récent en tête),
-- sinon toutes les conversations existantes se retrouveraient à égalité sur 0.
UPDATE `conversations` SET `position` = (
  SELECT COUNT(*) FROM `conversations` AS `c2`
  WHERE `c2`.`project_id` = `conversations`.`project_id`
    AND `c2`.`updated_at` > `conversations`.`updated_at`
);
