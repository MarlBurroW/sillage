import { sql } from 'drizzle-orm'
import { events } from '@sillage/db'

/**
 * Sorties d'outils volumineuses, retirées d'une page de journal relue.
 *
 * Une conversation longue est d'abord un problème d'octets. Sur la plus lourde en base,
 * `tool.completed` pèse 22 Mo des 32 du journal, et 16,6 de ces 22 tiennent dans 317
 * sorties de plus de 8 ko, une seule portant 649 ko. Depuis l'extérieur, c'est ce
 * transfert qui fait l'attente et non le rejeu.
 *
 * La sortie complète n'est pas perdue : le journal la garde, et la carte de l'appel la
 * demande à l'ouverture (`GET /api/conversations/:id/tools/:toolCallId/output`).
 *
 * Retirée plutôt que coupée en aperçu, comme elle l'était : la carte n'affiche rien d'une
 * sortie tant qu'elle n'a pas son corps complet, un extrait faisant clignoter une image
 * cassée avant le vrai contenu. L'aperçu ne servait donc qu'à peser.
 *
 * Et retirée par SQLite, pas en JS : lire une sortie de 6 Mo pour la jeter coûte au daemon
 * autant de mémoire que de la garder, et remplissait les pages de relecture d'octets
 * qu'elles n'envoyaient pas. La conversation qui en compte le plus demandait ainsi
 * davantage de pages une fois celles-ci bornées en octets.
 */

/** Au-delà, une sortie n'est pas relue. Assez pour qu'un résultat ordinaire arrive avec le fil. */
export const MAX_OUTPUT_BYTES = 8192

/** Taille de la sortie en JSON, celle que le client aurait reçue. */
const outputBytes = sql`octet_length(${events.payload} -> '$.output')`

/**
 * Payload à relire : celui du journal, sans la sortie quand elle dépasse la borne, et avec
 * sa taille dans `outputBytes`, qui dit à la carte de la demander.
 */
export const replayPayload = sql<string>`case
  when ${events.type} = 'tool.completed'
    and octet_length(${events.payload}) > ${MAX_OUTPUT_BYTES}
    and ${outputBytes} > ${MAX_OUTPUT_BYTES}
  then json_set(${events.payload}, '$.output', null, '$.outputBytes', ${outputBytes})
  else ${events.payload} end`

/**
 * Octets qu'une ligne pèsera une fois relue, estimés sans la lire. Un `tool.completed`
 * ne dépasse pas sa borne de sortie, le reste de son payload tenant en quelques
 * centaines d'octets.
 */
export const replayWeight = sql<number>`case
  when ${events.type} = 'tool.completed'
  then min(octet_length(${events.payload}), ${MAX_OUTPUT_BYTES + 1024})
  else octet_length(${events.payload}) end`
