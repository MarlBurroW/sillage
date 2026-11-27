import type { TurnUsage } from '../turn-lifecycle.js'
import { fields } from './tools.js'

/**
 * Grok's `_x.ai/session/usage` answers `{usage: {inputTokens, cachedReadTokens, cacheCreationTokens,
 * outputTokens, costUsdTicks, modelUsage, …}}`: totals since the process started, background
 * sub-agents and wake-up turns included. It is the only complete source: a prompt answered while a
 * background sub-agent still runs carries `usageIsIncomplete` and no `costUsdTicks`, the sub-agent's
 * own `turn_completed` arrives under its session afterwards, and wake-up turns answer no prompt.
 * Probed on 1.0.62 and 1.0.94: the total already holds the prompt's cost when the prompt answers,
 * takes in a sub-agent as soon as its `turn_completed` is sent, and restarts from zero in a
 * process that resumed the session.
 */
export interface SessionUsage {
  inputTokens: number
  cachedReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  costUsdTicks: number
}

const KEYS = ['inputTokens', 'cachedReadTokens', 'cacheCreationTokens', 'outputTokens', 'costUsdTicks'] as const

export const NO_USAGE: SessionUsage = { inputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, costUsdTicks: 0 }

/** Totals of a `_x.ai/session/usage` response; null when it holds none (an older CLI, an error). */
export function parseSessionUsage(response: unknown): SessionUsage | null {
  const usage = fields(fields(response).usage)
  if (typeof usage.inputTokens !== 'number') return null
  const read = (key: typeof KEYS[number]) => {
    const value = usage[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }
  return Object.fromEntries(KEYS.map((key) => [key, read(key)])) as unknown as SessionUsage
}

/** What was consumed between two readings. A counter going backwards is a restarted process: its totals are all new. */
export function usageSince(previous: SessionUsage, next: SessionUsage): SessionUsage {
  const restarted = KEYS.some((key) => next[key] < previous[key])
  if (restarted) return next
  return Object.fromEntries(KEYS.map((key) => [key, next[key] - previous[key]])) as unknown as SessionUsage
}

export function consumedAnything(usage: SessionUsage): boolean {
  return KEYS.some((key) => usage[key] > 0)
}

/** `costUsdTicks` are ten-billionths of dollars (probed: $0.033 for 330,643,200). */
const USD_PER_TICK = 1e-10

/** Journal counters of Grok usage, from a prompt response or a reading. Grok `inputTokens` includes the cache it reports apart; journals separate both like other CLIs. */
export function toTurnUsage(usage: Partial<SessionUsage> | undefined): TurnUsage {
  return {
    costUsd: (usage?.costUsdTicks ?? 0) * USD_PER_TICK,
    inputTokens: Math.max(0, (usage?.inputTokens ?? 0) - (usage?.cachedReadTokens ?? 0)),
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cachedReadTokens ?? 0,
    cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
  }
}
