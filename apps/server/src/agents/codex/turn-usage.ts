import type { ThreadTokenUsageUpdatedNotification, TokenUsageBreakdown } from '@sillage/codex-bindings/v2'

/** Le total natif est cumulatif ; le journal attend la consommation de chaque tour. */
export class CodexTurnUsage {
  private previous: TokenUsageBreakdown | null = null
  private turnId: string | null = null
  private input = 0
  private output = 0
  private cached = 0
  private written = 0

  start(turnId: string): void {
    this.turnId = turnId
    this.input = this.output = this.cached = this.written = 0
  }

  update(notification: ThreadTokenUsageUpdatedNotification): void {
    const { total, last } = notification.tokenUsage
    if (notification.turnId === this.turnId) {
      const delta = (key: keyof TokenUsageBreakdown) => Math.max(0,
        this.previous ? (total[key] ?? 0) - (this.previous[key] ?? 0) : (last[key] ?? 0),
      )
      this.input += delta('inputTokens')
      this.output += delta('outputTokens')
      this.cached += delta('cachedInputTokens')
      this.written += delta('cacheWriteInputTokens')
    }
    this.previous = total
  }

  finish() {
    this.turnId = null
    return {
      inputTokens: Math.max(0, this.input - this.cached - this.written),
      outputTokens: this.output,
      cacheReadTokens: this.cached,
      cacheCreationTokens: this.written,
    }
  }
}
