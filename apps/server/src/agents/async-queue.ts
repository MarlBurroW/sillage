/** Asynchronous input queue for SDK streaming mode. SDKs consume AsyncIterable user messages and keep channels open until completion. Persistent stdin enables bidirectional controls and interactive permissions; otherwise Claude refuses tools rather than asks. */
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
