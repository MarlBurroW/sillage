import type { AgentKind, BenchmarkRunMetrics, JournalEntry, SillageEvent } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'

/** 3: durations count working time only, without human waits or idle gaps between turns. */
export const RUN_METRICS_VERSION = 3

type MetricEntry = JournalEntry & { raw?: unknown }

/** Native Claude costs are cumulative; per-result model usage also includes auxiliary models. */
function claudeResult(raw: unknown) {
  if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'result') return null
  const result = raw as Record<string, unknown>
  const totalCost = typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0 ? result.total_cost_usd : null
  const usage = result.model_usage_since_last_result
  if (!usage || typeof usage !== 'object') return { totalCost, usage: null }
  const models = Object.values(usage) as Record<string, unknown>[]
  const keys = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'] as const
  if (!models.length || models.some((model) => !model || keys.some((key) => typeof model[key] !== 'number' || !Number.isFinite(model[key]) || (model[key] as number) < 0))) {
    return { totalCost, usage: null }
  }
  const sum = (key: typeof keys[number]) => models.reduce((total, model) => total + (model[key] as number), 0)
  return { totalCost, usage: {
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'), cacheCreationTokens: sum('cacheCreationInputTokens'),
    costUsd: sum('costUSD'),
  } }
}

/**
 * A run's stopwatch. It runs while the agent works, in a turn or on background tasks and loops it
 * started, and stops while a blocking request waits for a human, or when the session sits idle
 * between turns. Every CLI opens and closes its requests through `PendingInteractions` and reports
 * turns in the same journal vocabulary, so this one clock times them all alike.
 */
export class RunClock {
  /** Working time so far. */
  activeMs = 0
  /** Time with at least one blocking request open; overlapping requests count once. */
  waitingMs = 0
  private inTurn = false
  private background = 0
  private loops = 0
  private readonly waiting = new Set<string>()
  private at: number | null = null

  /** Folds one event. Events must arrive in journal order. */
  observe(ts: number, event: SillageEvent): void {
    this.advance(ts)
    switch (event.type) {
      case 'permission.requested':
      case 'question.requested':
      case 'plan.review_requested':
      case 'elicitation.requested':
        if (event.type === 'question.requested' && event.blocking === false) break
        this.waiting.add(event.requestId)
        break
      case 'permission.resolved':
      case 'question.resolved':
      case 'plan.review_resolved':
      case 'elicitation.resolved':
        this.waiting.delete(event.requestId)
        break
      case 'message.started':
        if (event.role === 'user') this.inTurn = true
        break
      case 'turn.started':
        this.inTurn = true
        break
      case 'turn.completed':
        this.inTurn = false
        break
      // Between turns the agent may still wait on a build or a server it started: its own work.
      case 'background.updated':
        this.background = event.tasks.length
        break
      case 'loops.updated':
        this.loops = event.loops.length
        break
      case 'session.ended':
        // The CLI is gone, and its turn, background work and requests with it.
        this.inTurn = false
        this.background = 0
        this.loops = 0
        this.waiting.clear()
        break
      default:
        break
    }
  }

  /** Brings the clock to `ts` without an event: the journal's last word, or now for a live run. */
  advance(ts: number): void {
    if (this.at !== null && ts > this.at) {
      if (this.waiting.size > 0) this.waitingMs += ts - this.at
      else if (this.inTurn || this.background > 0 || this.loops > 0) this.activeMs += ts - this.at
    }
    if (this.at === null || ts > this.at) this.at = ts
  }
}

/**
 * Folds a run's journal into its measurements.
 *
 * Pure over journal entries so tests feed events directly. Every CLI lands in the same journal
 * vocabulary, so one fold serves Claude, Codex, Grok and the ACP agents alike; what a CLI never
 * reports stays null rather than becoming a zero that would rank it first.
 */
export function computeRunMetrics(entries: MetricEntry[], agent?: AgentKind): BenchmarkRunMetrics {
  let startedAt: number | null = null
  let completedAt: number | null = null
  let firstTextAt: number | null = null
  let usageReported = false
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let costUsd = 0
  let previousClaudeCost = 0
  let costReported = false
  let toolCalls = 0
  const toolsByName: Record<string, number> = {}
  let toolErrors = 0
  let toolDurationMs = 0
  const startedTools = new Set<string>()
  const completedTools = new Set<string>()
  const assistantIds = new Set<string>()
  let outputChars = 0
  let contextTokens: number | null = null
  let model: string | null = null
  // Durations read the stopwatch, not the wall: a request left open for an hour, or a pause
  // between turns, is nobody's work.
  const clock = new RunClock()
  let completedActive = 0
  let firstTextActive = 0
  let lastTs: number | null = null

  for (const { ts, event, raw } of entries) {
    lastTs = ts
    clock.observe(ts, event)
    switch (event.type) {
      case 'message.started':
        // The user message opens the clock: the time before it is Sillage starting the CLI,
        // which the user also waits for but which does not belong to the model.
        if (event.role === 'user' && startedAt === null) startedAt = ts
        if (event.role === 'assistant') assistantIds.add(event.messageId)
        break
      case 'turn.started':
        if (startedAt === null) startedAt = ts
        break
      case 'message.delta':
        // Deltas carry no role, but only assistants stream: the first one is the first text.
        if (firstTextAt === null && event.text.length > 0) {
          firstTextAt = ts
          firstTextActive = clock.activeMs
        }
        break
      case 'message.completed':
        if (event.role !== 'assistant') break
        assistantIds.add(event.messageId)
        for (const block of event.blocks) {
          if (block.type !== 'text' || block.text.length === 0) continue
          outputChars += block.text.length
          if (firstTextAt === null) {
            firstTextAt = ts
            firstTextActive = clock.activeMs
          }
        }
        break
      case 'tool.started':
        if (startedTools.has(event.toolCallId)) break
        startedTools.add(event.toolCallId)
        toolCalls += 1
        toolsByName[event.name] = (toolsByName[event.name] ?? 0) + 1
        break
      case 'tool.completed':
        if (completedTools.has(event.toolCallId)) break
        completedTools.add(event.toolCallId)
        if (event.isError) toolErrors += 1
        toolDurationMs += event.durationMs
        break
      case 'turn.completed': {
        completedAt = ts
        completedActive = clock.activeMs
        const native = agent === 'claude' ? claudeResult(raw) : null
        const usage = native?.usage ?? event
        usageReported ||= usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0
        // Journal input counts exclude cache. Benchmarks compare all processed input, with
        // cache columns describing subsets rather than additional consumption.
        inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
        outputTokens += usage.outputTokens
        cacheReadTokens += usage.cacheReadTokens
        cacheCreationTokens += usage.cacheCreationTokens
        costReported ||= (native !== null && (native.usage !== null || native.totalCost !== null)) || event.costUsd > 0
        if (native?.usage) costUsd += native.usage.costUsd
        else if (native && typeof native.totalCost === 'number') {
          costUsd += Math.max(0, native.totalCost >= previousClaudeCost ? native.totalCost - previousClaudeCost : native.totalCost)
        } else costUsd += event.costUsd
        if (native && typeof native.totalCost === 'number') previousClaudeCost = native.totalCost
        break
      }
      case 'usage.updated':
        // These are context snapshots, not turn totals. Never manufacture zero consumption
        // from an interrupted run that emitted snapshots but no final usage.
        if (event.context) contextTokens = event.context.usedTokens
        break
      case 'session.started':
        agent = event.agent
        model = event.model
        break
      default:
        break
    }
  }

  // A request still open when the run was cut off waited until the journal's last word.
  if (lastTs !== null) clock.advance(lastTs)

  const elapsed = (end: number | null) => (startedAt !== null && end !== null && end >= startedAt ? end - startedAt : null)
  const worked = (end: number | null, active: number) => (elapsed(end) === null ? null : active)
  return {
    version: RUN_METRICS_VERSION,
    durationMs: worked(completedAt, completedActive),
    elapsedMs: elapsed(completedAt),
    waitingMs: clock.waitingMs,
    firstTextMs: worked(firstTextAt, firstTextActive),
    inputTokens: usageReported ? inputTokens : null,
    outputTokens: usageReported ? outputTokens : null,
    cacheReadTokens: usageReported ? cacheReadTokens : null,
    cacheCreationTokens: usageReported ? cacheCreationTokens : null,
    // Zero is also the journal default for CLIs with no cost report (including Codex).
    // Without an explicit price, it cannot establish that a run was free.
    costUsd: costReported ? costUsd : null,
    toolCalls,
    toolsByName,
    toolErrors,
    toolDurationMs,
    assistantMessages: assistantIds.size,
    outputChars,
    contextTokens,
    model,
  }
}

/**
 * Brings a snapshot whose journal is gone up to the current fold, as far as its own numbers go:
 * the human wait comes off its duration, idle gaps between turns cannot be told apart and stay.
 */
export function upgradeSnapshot(metrics: BenchmarkRunMetrics): BenchmarkRunMetrics {
  const version = metrics.version ?? 0
  let upgraded: BenchmarkRunMetrics = { ...metrics, version: RUN_METRICS_VERSION }
  if (version < 2) {
    upgraded = { ...upgraded,
      inputTokens: metrics.inputTokens === null ? null : metrics.inputTokens + (metrics.cacheReadTokens ?? 0) + (metrics.cacheCreationTokens ?? 0),
      costUsd: metrics.costUsd === 0 ? null : metrics.costUsd }
  }
  if (version < 3) {
    upgraded = { ...upgraded, elapsedMs: metrics.durationMs,
      durationMs: metrics.durationMs === null ? null : Math.max(0, metrics.durationMs - (metrics.waitingMs ?? 0)) }
  }
  return upgraded
}

/** Event types the fold reads; everything else, tool output deltas above all, stays on disk. */
const METRIC_EVENT_TYPES = [
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'plan.review_requested',
  'plan.review_resolved',
  'elicitation.requested',
  'elicitation.resolved',
  'session.started',
  'session.ended',
  'background.updated',
  'loops.updated',
  'error',
  'turn.started',
  'turn.completed',
  'message.started',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'usage.updated',
]

/** Pages the replay projection: large tool outputs are already trimmed there, so a long run stays cheap to fold. */
export function readRunMetrics(log: EventLog, conversationId: string, agent?: AgentKind, throughTs = Infinity): BenchmarkRunMetrics {
  const entries: MetricEntry[] = []
  let after = 0
  for (;;) {
    const page = log.readForReplay(conversationId, after, { rows: 2000, bytes: 8 * 1024 * 1024, unfiltered: true, onlyTypes: METRIC_EVENT_TYPES })
    for (const entry of page.entries) {
      if (entry.ts > throughTs) return computeRunMetrics(entries, agent)
      if (entry.event.type === 'session.started') agent = entry.event.agent
      entries.push(entry.event.type === 'turn.completed' && agent === 'claude'
        ? { ...entry, raw: log.lastRawOfType(conversationId, 'turn.completed', entry.seq) }
        : entry)
    }
    if (page.nextAfter <= after) break
    after = page.nextAfter
  }
  return computeRunMetrics(entries, agent)
}

const REQUEST_EVENT_TYPES = [
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'plan.review_requested',
  'plan.review_resolved',
  'elicitation.requested',
  'elicitation.resolved',
  'session.ended',
]

/** Human waiting of a live run until `now`, a request still open included. Reads only request events, so a sweep can afford it. */
export function readWaitingMs(log: EventLog, conversationId: string, now: number, since = 0): number {
  const clock = new RunClock()
  // Waiting before `since` belongs to an earlier attempt: only what follows counts.
  let before: number | null = null
  const reach = (ts: number) => {
    if (before !== null || ts <= since) return
    clock.advance(since)
    before = clock.waitingMs
  }
  let after = 0
  for (;;) {
    const page = log.readForReplay(conversationId, after, { rows: 2000, bytes: 8 * 1024 * 1024, unfiltered: true, onlyTypes: REQUEST_EVENT_TYPES })
    for (const entry of page.entries) {
      reach(entry.ts)
      clock.observe(entry.ts, entry.event)
    }
    if (page.nextAfter <= after) break
    after = page.nextAfter
  }
  reach(now)
  clock.advance(now)
  return clock.waitingMs - (before ?? 0)
}
