ALTER TABLE `conversations` RENAME COLUMN "message_count" TO "exchange_count";--> statement-breakpoint
-- La colonne comptait tous les messages du fil, or l'agent en produit un par appel
-- d'outil : une conversation de quatre demandes s'annonçait à cent soixante-huit, ce qui
-- décrivait ses étapes et non ses échanges. Le compte est repris sur les seuls messages
-- de l'utilisateur, un par échange, réponse rattachée : les traits de la réglette de
-- repères, pour que les deux surfaces s'accordent sur le même fil.
UPDATE `conversations` SET `exchange_count` = (
	SELECT count(DISTINCT event.payload ->> '$.messageId')
	FROM `events` AS event
	WHERE event.conversation_id = `conversations`.`id`
	  AND event.type = 'message.completed'
	  AND event.payload ->> '$.role' = 'user'
	  AND coalesce(event.payload ->> '$.parentToolCallId', '') = ''
);
