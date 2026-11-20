import type { AgentKind, SillageEvent } from '@sillage/protocol'
import type { TokenCounts } from '../pricing/prices.js'

/** What one model consumed during one turn. */
export interface ModelTurnUsage extends TokenCounts {
  model: string
  /** API-equivalent cost the CLI announced for it; null when it announced none. */
  reportedCostUsd: number | null
}

type TurnCompleted = Extract<SillageEvent, { type: 'turn.completed' }>
type UsageConsumed = Extract<SillageEvent, { type: 'usage.consumed' }>

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheCreationEphemeral1hInputTokens', 'costUSD'] as const
/** Per-model counters of a Claude `result`, reduced to the keys read here. */
export type ClaudeModelUsage = Record<string, Record<typeof USAGE_KEYS[number], number>>

function claudeModelUsage(value: unknown): ClaudeModelUsage | null {
  if (!value || typeof value !== 'object') return null
  const usage: ClaudeModelUsage = {}
  for (const [model, counters] of Object.entries(value as Record<string, Record<string, unknown> | null>)) {
    const read = (key: string) => {
      const count = counters?.[key]
      return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0
    }
    usage[model] = Object.fromEntries(USAGE_KEYS.map((key) => [key, read(key)])) as ClaudeModelUsage[string]
  }
  return Object.keys(usage).length ? usage : null
}

/**
 * Reads a Claude `result`, the only place where auxiliary models and subagents appear.
 *
 * Recent CLIs give the turn's own counters. Older ones only give `modelUsage`, cumulative since
 * the CLI process started: the turn is then the difference with the previous result, and a
 * counter going backwards is a restarted process, counted from zero.
 *
 * `cumulative` is what the next call must receive as `previous`; null when the result carries
 * no usable counters, leaving the journal's own totals as the only source.
 */
export function claudeTurnUsage(raw: unknown, previous: ClaudeModelUsage | null): { rows: ModelTurnUsage[]; cumulative: ClaudeModelUsage | null } | null {
  if (!raw || typeof raw !== 'object' || (raw as { type?: unknown }).type !== 'result') return null
  const result = raw as Record<string, unknown>
  const cumulative = claudeModelUsage(result.modelUsage)
  let turn = claudeModelUsage(result.model_usage_since_last_result)
  if (!turn && cumulative) {
    turn = {}
    for (const [model, counters] of Object.entries(cumulative)) {
      const before = previous?.[model]
      const restarted = !before || USAGE_KEYS.some((key) => counters[key] < before[key])
      turn[model] = restarted ? counters : Object.fromEntries(USAGE_KEYS.map((key) => [key, counters[key] - before[key]])) as ClaudeModelUsage[string]
    }
  }
  if (!turn) return null
  const native = (result.model_usage_since_last_result ?? result.modelUsage) as Record<string, Record<string, unknown> | null>
  const hourShare = oneHourShare(result.usage)
  const rows = Object.entries(turn).map(([model, counters]): ModelTurnUsage => {
    const written = counters.cacheCreationInputTokens
    // Results older than the per-model split only tell the lifetimes apart for the turn as a
    // whole: its proportion is applied to each model rather than pricing every write as short.
    const split = typeof native[model]?.cacheCreationEphemeral1hInputTokens === 'number'
    const hour = Math.min(written, split ? counters.cacheCreationEphemeral1hInputTokens : Math.round(written * hourShare))
    return {
      model,
      inputTokens: counters.inputTokens,
      outputTokens: counters.outputTokens,
      cacheReadTokens: counters.cacheReadInputTokens,
      cacheWriteTokens: written - hour,
      cacheWrite1hTokens: hour,
      reportedCostUsd: counters.costUSD,
    }
  })
  return { rows, cumulative: cumulative ?? previous }
}

/** Part of a turn's cache writes kept for an hour, from the `usage` of its result. */
function oneHourShare(usage: unknown): number {
  const written = (usage as { cache_creation?: { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown } } | null)?.cache_creation
  const hour = typeof written?.ephemeral_1h_input_tokens === 'number' ? written.ephemeral_1h_input_tokens : 0
  const short = typeof written?.ephemeral_5m_input_tokens === 'number' ? written.ephemeral_5m_input_tokens : 0
  return hour + short > 0 ? hour / (hour + short) : 0
}

/**
 * Cost of one Claude turn. `total_cost_usd` accumulates over the CLI process: adding it up turn
 * after turn counted a long conversation many times over. `previousTotal` is the last total seen
 * from the same process; a lower total is a restarted one.
 */
export function claudeTurnCost(result: { total_cost_usd?: unknown; model_usage_since_last_result?: unknown }, previousTotal: number): number {
  const turn = claudeModelUsage(result.model_usage_since_last_result)
  if (turn) return Object.values(turn).reduce((sum, counters) => sum + counters.costUSD, 0)
  const total = typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) && result.total_cost_usd > 0 ? result.total_cost_usd : 0
  return total >= previousTotal ? total - previousTotal : total
}

const consumed = (row: TokenCounts): boolean => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.cacheWrite1hTokens > 0

/**
 * Per-model consumption of a completed turn. Every CLI but Claude reports one total for the
 * model the session runs; turns closed by a watchdog or an import consumed nothing and give no
 * row.
 */
export function turnUsageOf(
  agent: AgentKind,
  event: TurnCompleted,
  raw: unknown,
  state: { model: string | null; claude: ClaudeModelUsage | null },
): { rows: ModelTurnUsage[]; claude: ClaudeModelUsage | null } {
  const native = agent === 'claude' ? claudeTurnUsage(raw, state.claude) : null
  if (native) return { rows: native.rows.filter(consumed), claude: native.cumulative }
  const row: ModelTurnUsage = {
    model: state.model ?? '',
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheCreationTokens,
    cacheWrite1hTokens: 0,
    // Zero is also what a CLI without any cost report writes; a Claude total read without its
    // result cannot be told apart from a cumulative one.
    reportedCostUsd: agent !== 'claude' && event.costUsd > 0 ? event.costUsd : null,
  }
  return { rows: consumed(row) ? [row] : [], claude: state.claude }
}

/** Consumption reported apart from a turn, under the model that ran it when the CLI said. */
export function consumedUsageOf(event: UsageConsumed, sessionModel: string | null): ModelTurnUsage[] {
  const row: ModelTurnUsage = {
    model: event.model ?? sessionModel ?? '',
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheCreationTokens,
    cacheWrite1hTokens: 0,
    reportedCostUsd: event.costUsd > 0 ? event.costUsd : null,
  }
  return consumed(row) ? [row] : []
}
