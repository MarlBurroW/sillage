import { and, eq, lte, sql } from 'drizzle-orm'
import { turnUsage, type Db } from '@sillage/db'
import type { PriceCatalog } from './catalog.js'
import { costOf, type TokenCounts } from './prices.js'

/**
 * Tokens a conversation consumed and what they would cost at today's public API prices, read from
 * its recorded turns like the consumption dashboard, so both always agree. Null when no turn was
 * recorded. The cost is null as soon as one model has no public price: a partial sum would read
 * as the whole.
 */
export function conversationUsage(db: Db, prices: PriceCatalog, conversationId: string, until: number | null = null): { costUsd: number | null; tokens: TokenCounts } | null {
  const turns = db
    .select({
      model: turnUsage.model,
      inputTokens: sql<number>`sum(${turnUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${turnUsage.outputTokens})`,
      cacheReadTokens: sql<number>`sum(${turnUsage.cacheReadTokens})`,
      cacheWriteTokens: sql<number>`sum(${turnUsage.cacheWriteTokens})`,
      cacheWrite1hTokens: sql<number>`sum(${turnUsage.cacheWrite1hTokens})`,
    })
    .from(turnUsage)
    .where(and(eq(turnUsage.conversationId, conversationId), until === null ? undefined : lte(turnUsage.ts, until)))
    .groupBy(turnUsage.model)
    .all()
  if (!turns.length) return null
  const tokens: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }
  let costUsd: number | null = 0
  for (const turn of turns) {
    for (const key of Object.keys(tokens) as (keyof TokenCounts)[]) tokens[key] += turn[key]
    const price = prices.priceOf(turn.model)
    costUsd = price && costUsd !== null ? costUsd + costOf(price, turn) : null
  }
  return { costUsd, tokens }
}
