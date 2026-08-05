-- « Échange » était un troisième mot pour ce que le reste du code appelle déjà un tour :
-- les événements `turn.started` / `turn.completed`, `TurnMarker` et `buildTurns` côté
-- web, jusqu'à l'étiquette de la réglette de repères. C'est ce tour-là que la colonne
-- compte, celui du découpage du fil, et non l'événement de cycle de vie du même nom.
--
-- Renommage seul : la colonne porte déjà le bon nombre depuis la migration précédente,
-- il n'y a rien à recalculer.
ALTER TABLE `conversations` RENAME COLUMN "exchange_count" TO "turn_count";
