ALTER TABLE `cards` ADD `column_entered_at` integer;--> statement-breakpoint
ALTER TABLE `cards` ADD `done_by_merge` text;--> statement-breakpoint
-- Les cartes existantes n'ont pas d'historique de colonne : leur dernière mise à jour
-- est la meilleure approximation de leur arrivée.
UPDATE `cards` SET `column_entered_at` = `updated_at`;
--> statement-breakpoint
-- À la création, la carte arrive dans sa colonne en même temps qu'elle naît.
CREATE TRIGGER `cards_column_entered_on_insert` AFTER INSERT ON `cards`
WHEN NEW.`column_entered_at` IS NULL
BEGIN
  UPDATE `cards` SET `column_entered_at` = NEW.`created_at` WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- Tout changement de colonne, quel qu'en soit l'auteur : interface, agent, GitHub.
CREATE TRIGGER `cards_column_entered_on_move` AFTER UPDATE OF `column` ON `cards`
WHEN NEW.`column` IS NOT OLD.`column`
BEGIN
  UPDATE `cards`
  SET `column_entered_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE `id` = NEW.`id`;
END;
