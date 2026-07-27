import { createInterface, type Interface } from 'node:readline'

/**
 * readline émet ses lignes dès qu'elles arrivent. Avec un `rl.question` par ligne, les
 * lignes reçues entre deux questions (cas d'un stdin redirigé) sont perdues en silence.
 * On écoute donc en continu et on met en file d'attente ce qui arrive en avance.
 */
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

  /** Saisie sans écho, pour ne pas laisser le mot de passe dans le scrollback. */
  async askHidden(question: string): Promise<string> {
    process.stdout.write(question)

    // En TTY, c'est readline qui réaffiche les caractères tapés, via _writeToOutput.
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
