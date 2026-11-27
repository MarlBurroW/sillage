import type { RunnerContext } from './types.js'

export interface TurnUsage {
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** See `turn.completed`. */
  model?: string
  aiCredits?: number
}

const NO_USAGE: TurnUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

export interface TurnEnd {
  stopReason: string
  usage?: TurnUsage
  /** Native payload journaled with `turn.completed`. */
  raw?: unknown
  /** Runner-specific closing (streamed text, tools still open), run before `turn.completed` so it lands inside the turn. */
  close?: () => void
}

/**
 * The turn bookkeeping every runner needs, written once. Each runner had its own `beginTurn`,
 * `endTurn` and interrupt watchdog, and they had drifted: a stale completion closed the next turn
 * in one runner and not another, a watchdog ended a turn without journaling `turn.completed` in a
 * third. Each turn gets a token: completions answering an earlier turn (a cancelled prompt
 * resolving after the next one started) are ignored instead of closing the turn in progress.
 */
export class TurnLifecycle {
  private current: number | null = null
  private counter = 0
  private watchdog: NodeJS.Timeout | null = null

  constructor(
    private readonly ctx: Pick<RunnerContext, 'emit' | 'setStatus'>,
    private readonly interactions: { readonly hasBlocking: boolean; expireAll(): void },
  ) {}

  get open(): boolean {
    return this.current !== null
  }

  /** Token of the turn in progress, null between turns. */
  get token(): number | null {
    return this.current
  }

  /**
   * Opens a turn unless one is open; returns its token either way. `status: false` journals the
   * turn without showing the conversation as working (history being imported).
   */
  begin(options: { status?: boolean } = {}): number {
    if (this.current !== null) return this.current
    this.current = ++this.counter
    this.ctx.emit({ type: 'turn.started' })
    if (options.status !== false) this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
    return this.current
  }

  /**
   * Closes the turn: runner-specific closing, prompts expired (nobody can answer them once the turn
   * is over), `turn.completed` journaled, conversation idle. With `token`, only that turn closes.
   * Returns whether it closed anything.
   */
  end(outcome: TurnEnd, token?: number): boolean {
    if (this.current === null) return false
    if (token !== undefined && token !== this.current) return false
    this.current = null
    this.clearWatchdog()
    outcome.close?.()
    this.interactions.expireAll()
    this.ctx.emit({ type: 'turn.completed', stopReason: outcome.stopReason, ...(outcome.usage ?? NO_USAGE) }, outcome.raw)
    this.ctx.setStatus('idle')
    return true
  }

  /**
   * After asking the CLI to stop: closes the turn after `graceMs` if the CLI never confirms. Bound to
   * the turn in progress, so it cannot close the next one.
   */
  armWatchdog(graceMs: number, onExpire: (token: number) => void): void {
    const token = this.current
    if (token === null) return
    this.clearWatchdog()
    this.watchdog = setTimeout(() => {
      this.watchdog = null
      if (this.current === token) onExpire(token)
    }, graceMs)
    this.watchdog.unref()
  }

  clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
  }

  /**
   * Interrupt with no turn open. Still an escape hatch: a conversation shown busy without a turn
   * would otherwise stay busy, so expire what waits and return to idle.
   */
  settleWithoutTurn(): void {
    this.interactions.expireAll()
    this.ctx.setStatus('idle')
  }

  /** The CLI process died: forget the turn without journaling its end, which `journalDeath` writes as `session.ended`. */
  abandon(): void {
    this.current = null
    this.clearWatchdog()
  }

  /** The runner is going away: no timer may fire on its context afterwards. */
  dispose(): void {
    this.clearWatchdog()
  }
}
