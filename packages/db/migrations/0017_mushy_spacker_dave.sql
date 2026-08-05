ALTER TABLE `conversations` ADD `message_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `journal_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `context_used_tokens` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `context_max_tokens` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `model` text;--> statement-breakpoint
-- Reprise de l'existant, sans quoi toutes les conversations déjà en base afficheraient
-- zéro message et aucun modèle jusqu'à leur prochain tour.
--
-- Les quatre relevés sont dérivés du journal, seule source (invariant I2) : ces colonnes
-- sont un cache de lecture, et cette requête est aussi ce que le serveur rejoue ensuite
-- à chaque fin de tour.
UPDATE `conversations` SET
	`message_count` = (
		SELECT count(DISTINCT event.payload ->> '$.messageId')
		FROM `events` AS event
		WHERE event.conversation_id = `conversations`.`id`
		  AND event.type = 'message.completed'
		  AND coalesce(event.payload ->> '$.parentToolCallId', '') = ''
	),
	-- `cast(... as blob)` parce que `length()` compte les caractères sur du texte : sans
	-- lui, un journal accentué ou riche en emoji est annoncé plus léger qu'il ne l'est.
	`journal_bytes` = (
		SELECT coalesce(sum(length(cast(event.payload AS blob)) + coalesce(length(cast(event.raw AS blob)), 0)), 0)
		FROM `events` AS event
		WHERE event.conversation_id = `conversations`.`id`
	);--> statement-breakpoint
-- Le CLI ré-émet son init quand le modèle change : la dernière occurrence fait foi.
UPDATE `conversations` SET `model` = (
	SELECT event.payload ->> '$.model'
	FROM `events` AS event
	WHERE event.conversation_id = `conversations`.`id`
	  AND event.type = 'session.started'
	ORDER BY event.seq DESC
	LIMIT 1
);--> statement-breakpoint
-- Le champ `context` est optionnel dans `usage.updated` : ne retenir que les relevés qui
-- le portent, sinon le dernier événement du fil efface le seul chiffre connu.
UPDATE `conversations` SET
	`context_used_tokens` = (
		SELECT event.payload ->> '$.context.usedTokens'
		FROM `events` AS event
		WHERE event.conversation_id = `conversations`.`id`
		  AND event.type = 'usage.updated'
		  AND event.payload ->> '$.context.usedTokens' IS NOT NULL
		ORDER BY event.seq DESC
		LIMIT 1
	),
	`context_max_tokens` = (
		SELECT event.payload ->> '$.context.maxTokens'
		FROM `events` AS event
		WHERE event.conversation_id = `conversations`.`id`
		  AND event.type = 'usage.updated'
		  AND event.payload ->> '$.context.maxTokens' IS NOT NULL
		ORDER BY event.seq DESC
		LIMIT 1
	);
