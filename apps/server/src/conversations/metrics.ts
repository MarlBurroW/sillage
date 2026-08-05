import type { ConversationRow } from '@sillage/db'
import type { ConversationMetrics } from '@sillage/protocol'

/**
 * Les colonnes du relevé, isolées pour que la diffusion de statut n'ait pas à lire la
 * ligne entière : elle passe déjà par là plusieurs fois par tour.
 */
export type MetricColumns = Pick<
  ConversationRow,
  'exchangeCount' | 'journalBytes' | 'contextUsedTokens' | 'contextMaxTokens' | 'model'
>

/**
 * Met en forme le relevé pour le client, seul endroit où les deux colonnes de contexte
 * redeviennent le couple qu'elles décrivent. Un maximum inconnu ne se remplace pas par
 * un défaut : sans lui, il n'y a pas de proportion à afficher.
 */
export function conversationMetrics(row: MetricColumns): ConversationMetrics {
  return {
    exchangeCount: row.exchangeCount,
    journalBytes: row.journalBytes,
    context:
      row.contextUsedTokens === null || row.contextMaxTokens === null
        ? null
        : { usedTokens: row.contextUsedTokens, maxTokens: row.contextMaxTokens },
    model: row.model,
  }
}
