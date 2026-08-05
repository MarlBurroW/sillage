ALTER TABLE `conversations` ADD `last_notable_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Rattrapage écrit à la main : la valeur par défaut de 0 est fausse pour tout
-- l'historique, et la laisser reviendrait à déclarer lu ce qui ne l'est pas. La liste
-- est celle de `NOTABLE` dans l'`EventLog`, à garder en phase avec elle.
UPDATE `conversations` SET `last_notable_seq` = COALESCE((
  SELECT MAX(`e`.`seq`) FROM `events` AS `e`
  WHERE `e`.`conversation_id` = `conversations`.`id`
    AND `e`.`type` IN (
      'turn.completed', 'error',
      'permission.requested', 'question.requested',
      'elicitation.requested', 'plan.review_requested'
    )
), 0);