/**
 * File asynchrone servant d'entrée au mode streaming du SDK.
 *
 * Le SDK consomme un AsyncIterable de messages utilisateur et garde le canal ouvert
 * tant qu'il n'est pas terminé. C'est cette persistance qui permet le protocole de
 * contrôle bidirectionnel, donc les demandes de permission interactives : sans stdin
 * maintenu, Claude Code refuse l'outil au lieu de demander.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private pending: ((result: IteratorResult<T>) => void) | null = null
  private closed = false

  push(item: T): void {
    if (this.closed) return

    const waiter = this.pending
    if (waiter) {
      this.pending = null
      waiter({ value: item, done: false })
    } else {
      this.buffer.push(item)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const waiter = this.pending
    if (waiter) {
      this.pending = null
      waiter({ value: undefined as never, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const buffered = this.buffer.shift()
      if (buffered !== undefined) {
        yield buffered
        continue
      }
      if (this.closed) return

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.pending = resolve
      })
      if (next.done) return
      yield next.value
    }
  }
}
