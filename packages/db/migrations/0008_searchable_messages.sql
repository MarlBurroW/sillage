-- Index de recherche plein texte sur les messages.
--
-- Table dérivée, jamais une source : le journal reste la seule vérité (invariant I2).
-- Elle peut être vidée et reconstruite depuis `events` à tout moment, ce que fait
-- `pnpm --filter @sillage/server search:reindex`.
--
-- Écrit à la main plutôt que généré : drizzle-kit ne connaît pas les tables virtuelles.
CREATE VIRTUAL TABLE `search_messages` USING fts5(
	text,
	conversation_id UNINDEXED,
	seq UNINDEXED,
	role UNINDEXED,
	ts UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- Reprise de l'existant. Seuls les blocs de texte des messages terminés sont indexés :
-- les deltas de streaming décrivent le même contenu en cours d'écriture.
INSERT INTO `search_messages` (text, conversation_id, seq, role, ts)
SELECT group_concat(block.value ->> '$.text', char(10)),
       event.conversation_id,
       event.seq,
       event.payload ->> '$.role',
       event.ts
FROM `events` AS event, json_each(event.payload ->> '$.blocks') AS block
WHERE event.type = 'message.completed'
  AND block.value ->> '$.type' = 'text'
GROUP BY event.conversation_id, event.seq;
