import type { BenchmarkRunMetrics, JournalEntry } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'

/**
 * Folds a run's journal into its measurements.
 *
 * Pure over journal entries so tests feed events directly. Every CLI lands in the same journal
 * vocabulary, so one fold serves Claude, Codex, Grok and the ACP agents alike; what a CLI never
 * reports stays null rather than becoming a zero that would rank it first.
 */
export function computeRunMetrics(entries: JournalEntry[]): BenchmarkRunMetrics {
  let startedAt: number | null = null
  let completedAt: number | null = null
  let firstTextAt: number | null = null
  let usageReported = false
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let costUsd = 0
  let toolCalls = 0
  const toolsByName: Record<string, number> = {}
  let toolErrors = 0
  let toolDurationMs = 0
  const assistantIds = new Set<string>()
  let outputChars = 0
  let contextTokens: number | null = null
  let model: string | null = null
  // Requests waiting for a human, by id: their open time is not the model's.
  const waiting = new Map<string, number>()
  let waitingMs = 0
  let lastTs: number | null = null

  for (const { ts, event } of entries) {
    lastTs = ts
    switch (event.type) {
      case 'permission.requested':
      case 'question.requested':
      case 'plan.review_requested':
      case 'elicitation.requested':
        waiting.set(event.requestId, ts)
        break
      case 'permission.resolved':
      case 'question.resolved':
      case 'plan.review_resolved':
      case 'elicitation.resolved': {
        const since = waiting.get(event.requestId)
        if (since !== undefined) waitingMs += ts - since
        waiting.delete(event.requestId)
        break
      }
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
        if (firstTextAt === null && event.text.length > 0) firstTextAt = ts
        break
      case 'message.completed':
        if (event.role !== 'assistant') break
        assistantIds.add(event.messageId)
        for (const block of event.blocks) {
          if (block.type !== 'text' || block.text.length === 0) continue
          outputChars += block.text.length
          if (firstTextAt === null) firstTextAt = ts
        }
        break
      case 'tool.started':
        toolCalls += 1
        toolsByName[event.name] = (toolsByName[event.name] ?? 0) + 1
        break
      case 'tool.completed':
        if (event.isError) toolErrors += 1
        toolDurationMs += event.durationMs
        break
      case 'turn.completed':
        completedAt = ts
        usageReported = usageReported || event.inputTokens > 0 || event.outputTokens > 0 || event.cacheReadTokens > 0 || event.cacheCreationTokens > 0
        inputTokens += event.inputTokens
        outputTokens += event.outputTokens
        cacheReadTokens += event.cacheReadTokens
        cacheCreationTokens += event.cacheCreationTokens
        costUsd += event.costUsd
        break
      case 'usage.updated':
        usageReported = usageReported || event.inputTokens > 0 || event.outputTokens > 0
        if (event.context) contextTokens = event.context.usedTokens
        break
      case 'session.started':
        model = event.model
        break
      default:
        break
    }
  }

  // A request still open when the run was cut off waited until the journal's last word.
  for (const since of waiting.values()) if (lastTs !== null) waitingMs += lastTs - since

  const elapsed = (end: number | null) => (startedAt !== null && end !== null && end >= startedAt ? end - startedAt : null)
  return {
    durationMs: elapsed(completedAt),
    waitingMs,
    firstTextMs: elapsed(firstTextAt),
    inputTokens: usageReported ? inputTokens : null,
    outputTokens: usageReported ? outputTokens : null,
    cacheReadTokens: usageReported ? cacheReadTokens : null,
    cacheCreationTokens: usageReported ? cacheCreationTokens : null,
    // A cost without any token report is a CLI default, not a measurement.
    costUsd: usageReported || costUsd > 0 ? costUsd : null,
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
export function readRunMetrics(log: EventLog, conversationId: string): BenchmarkRunMetrics {
  const entries: JournalEntry[] = []
  let after = 0
  for (;;) {
    const page = log.readForReplay(conversationId, after, { rows: 2000, bytes: 8 * 1024 * 1024, unfiltered: true, onlyTypes: METRIC_EVENT_TYPES })
    entries.push(...page.entries)
    if (page.nextAfter <= after) break
    after = page.nextAfter
  }
  return computeRunMetrics(entries)
}
