import type { ConversationRow } from '@sillage/db'
import type { ConversationMetrics } from '@sillage/protocol'

/** Usage columns selected separately so status broadcasting avoids reading entire rows several times per turn. */
export type MetricColumns = Pick<
  ConversationRow,
  'turnCount' | 'journalBytes' | 'contextUsedTokens' | 'contextMaxTokens' | 'model'
>

/** Formats usage for clients, the sole place where two context columns become their pair again. Never substitute defaults for unknown maxima: without them there is no ratio to display. */
export function conversationMetrics(row: MetricColumns): ConversationMetrics {
  return {
    turnCount: row.turnCount,
    journalBytes: row.journalBytes,
    context:
      row.contextUsedTokens === null || row.contextMaxTokens === null
        ? null
        : { usedTokens: row.contextUsedTokens, maxTokens: row.contextMaxTokens },
    model: row.model,
  }
}
