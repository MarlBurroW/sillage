import { createInterface, type Interface } from 'node:readline'

/** readline emits lines immediately. Per-line `rl.question` loses redirected-stdin lines arriving between questions; listen continuously and queue early arrivals. */
export class Prompter {
  private readonly rl: Interface
  private readonly queue: string[] = []
  private pending: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null
  private closed = false

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout })

    this.rl.on('line', (line) => {
      const waiter = this.pending
      if (waiter) {
        this.pending = null
        waiter.resolve(line)
      } else {
        this.queue.push(line)
      }
    })

    this.rl.on('close', () => {
      this.closed = true
      this.pending?.reject(new Error('Saisie interrompue.'))
      this.pending = null
    })
  }

  private nextLine(): Promise<string> {
    const buffered = this.queue.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.closed) return Promise.reject(new Error('Saisie interrompue.'))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  async ask(question: string): Promise<string> {
    process.stdout.write(question)
    return (await this.nextLine()).trim()
  }

  /** Non-echoing input avoids leaving passwords in scrollback. */
  async askHidden(question: string): Promise<string> {
    process.stdout.write(question)

    // In TTYs, readline echoes typed characters through _writeToOutput.
    const internals = this.rl as Interface & { _writeToOutput?: (s: string) => void }
    const echo = internals._writeToOutput
    internals._writeToOutput = () => {}
    try {
      return (await this.nextLine()).trim()
    } finally {
      internals._writeToOutput = echo
      process.stdout.write('\n')
    }
  }

  close(): void {
    this.rl.close()
  }
}
