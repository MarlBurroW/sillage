import type { ThreadTokenUsageUpdatedNotification, TokenUsageBreakdown } from '@sillage/codex-bindings/v2'

interface Counters { input: number; output: number; cached: number; written: number }

const zero = (): Counters => ({ input: 0, output: 0, cached: 0, written: 0 })

/** Native totals are cumulative per thread: what one notification adds since the previous one. */
function add(into: Counters, { total, last }: ThreadTokenUsageUpdatedNotification['tokenUsage'], previous: TokenUsageBreakdown | null): void {
  const delta = (key: keyof TokenUsageBreakdown) => Math.max(0,
    previous ? (total[key] ?? 0) - (previous[key] ?? 0) : (last[key] ?? 0),
  )
  into.input += delta('inputTokens')
  into.output += delta('outputTokens')
  into.cached += delta('cachedInputTokens')
  into.written += delta('cacheWriteInputTokens')
}

/** Codex input includes its cache reads and writes; journals keep them apart like other CLIs. */
function journaled(counters: Counters) {
  return {
    inputTokens: Math.max(0, counters.input - counters.cached - counters.written),
    outputTokens: counters.output,
    cacheReadTokens: counters.cached,
    cacheCreationTokens: counters.written,
  }
}

/** The main thread's usage, per turn. */
export class CodexTurnUsage {
  private previous: TokenUsageBreakdown | null = null
  private turnId: string | null = null
  private counters = zero()

  start(turnId: string): void {
    this.turnId = turnId
    this.counters = zero()
  }

  update(notification: ThreadTokenUsageUpdatedNotification): void {
    if (notification.turnId === this.turnId) add(this.counters, notification.tokenUsage, this.previous)
    this.previous = notification.tokenUsage.total
  }

  finish() {
    this.turnId = null
    return journaled(this.counters)
  }
}

/**
 * Sub-agents run on threads of their own, whose usage the main thread's totals never include:
 * on 2026-11-19 the 167 sub-agent threads still on disk had consumed 2.2 billion input tokens
 * that Sillage had not recorded. Their turns can outlive the main one, so each is settled when
 * it ends rather than folded into the turn that spawned it.
 */
export class CodexSubAgentUsage {
  private readonly threads = new Map<string, { model: string | null; previous: TokenUsageBreakdown | null; pending: Counters }>()

  private thread(id: string) {
    let thread = this.threads.get(id)
    if (!thread) this.threads.set(id, thread = { model: null, previous: null, pending: zero() })
    return thread
  }

  setModel(threadId: string, model: string | null): void {
    if (model) this.thread(threadId).model = model
  }

  /** Every turn of a sub-agent counts, whichever started it: none of them is the main turn. */
  update(notification: ThreadTokenUsageUpdatedNotification): void {
    const thread = this.thread(notification.threadId)
    add(thread.pending, notification.tokenUsage, thread.previous)
    thread.previous = notification.tokenUsage.total
  }

  /** What the thread consumed since its last settlement, or null when nothing. */
  settle(threadId: string): ({ model: string | null } & ReturnType<typeof journaled>) | null {
    const thread = this.threads.get(threadId)
    if (!thread) return null
    const { pending } = thread
    thread.pending = zero()
    if (pending.input + pending.output + pending.cached + pending.written === 0) return null
    return { model: thread.model, ...journaled(pending) }
  }

  /** Threads with usage not settled yet, for a runner shutting down mid sub-agent turn. */
  unsettled(): string[] {
    return [...this.threads].filter(([, thread]) => thread.pending.input + thread.pending.output > 0).map(([id]) => id)
  }
}
