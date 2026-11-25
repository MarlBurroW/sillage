import type { Db } from '@sillage/db'
import type { BenchmarkRunMetrics } from '@sillage/protocol'
import type { PriceCatalog } from '../pricing/catalog.js'
import { conversationUsage } from '../pricing/conversation-usage.js'
import { costOf } from '../pricing/prices.js'

/**
 * What a run would cost at today's public API prices, like the consumption dashboard: the two
 * must agree, and only a price list compares a CLI that reports a cost with one that does not.
 *
 * Read from the turns recorded for the run's conversation, per model and up to its settlement,
 * since a discussion continued afterwards is not the benchmark. A run whose turns were never
 * recorded (its conversation deleted before they were) falls back on its stored totals, priced
 * as the model the session announced. Null as soon as one model has no public price: a partial
 * cost would rank a variant on what happens to be listed.
 */
export function runCostUsd(db: Db, prices: PriceCatalog, run: { conversationId: string | null; finishedAt: number | null }, metrics: BenchmarkRunMetrics): number | null {
  const recorded = run.conversationId ? conversationUsage(db, prices, run.conversationId, run.finishedAt) : null
  if (recorded) return recorded.costUsd
  const price = metrics.model ? prices.priceOf(metrics.model) : null
  if (!price || metrics.inputTokens === null || metrics.outputTokens === null) return null
  const cacheReadTokens = metrics.cacheReadTokens ?? 0
  const cacheWriteTokens = metrics.cacheCreationTokens ?? 0
  return costOf(price, {
    // The stored input total includes the cache, which has its own rates.
    inputTokens: Math.max(0, metrics.inputTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens: metrics.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: 0,
  })
}
