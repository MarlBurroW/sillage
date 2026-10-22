/**
 * Tool duration measured from announcement to result.
 *
 * Fallback when CLI omits duration, zero if start unseen (resume, orphan result).
 */
export class ToolDurations {
  private readonly startedAt = new Map<string, number>()

  start(id: string): void {
    this.startedAt.set(id, Date.now())
  }

  stop(id: string): number {
    const started = this.startedAt.get(id)
    this.startedAt.delete(id)
    return started ? Date.now() - started : 0
  }
}
