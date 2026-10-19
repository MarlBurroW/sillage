import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { launchOf } from '../launch.js'
import { createInterface, type Interface } from 'node:readline'
import type { InitializeRequest, InitializeResponse } from '@agentclientprotocol/sdk'

/**
 * Client JSON-RPC de l'Agent Client Protocol (ACP), sur stdio et délimité par des sauts
 * de ligne : le protocole qu'un éditeur comme Zed parle aux agents, et que Grok Build
 * expose par `grok agent stdio`.
 *
 * Écrit à la main plutôt que par la `ClientSideConnection` du SDK officiel, dont seuls
 * les types sont repris : le SDK valide chaque message entrant avec son schéma zod, et
 * un agent qui ajoute ses propres variantes de `session/update` (Grok en publie sous
 * `_x.ai/…`) verrait ces messages rejetés au lieu d'être montrés une fois en notice. Le
 * même parti que pour `codex app-server` : un transport minimal, sans logique métier,
 * et le runner décide de ce qui se traduit.
 */

/** Délai par défaut d'une requête. `session/prompt`, qui dure le tour, n'en a pas. */
const REQUEST_TIMEOUT_MS = 30_000

/** Conserve le code RPC : un refus de l'agent n'est pas une panne de transport. */
export class AcpRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message)
    this.name = 'AcpRpcError'
  }
}

type RpcId = string | number

interface PendingCall {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

export interface AcpClientOptions {
  /** Nom court du CLI, pour préfixer ce qu'il écrit sur stderr dans les logs. */
  label: string
  binary: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Notifications de l'agent (`session/update`, et ses extensions `_…`). */
  onNotification?: (method: string, params: unknown) => void
  /**
   * Requêtes de l'agent à répondre : `session/request_permission`, et tout ce que le
   * client n'a pas déclaré savoir faire. Une exception devient une erreur RPC.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown>
  /** Mort du process hors d'un `close()` demandé, voir `CodexClientOptions.onExit`. */
  onExit?: (code: number | null, stderrTail: string) => void
}

/** Ce que stderr garde en mémoire, pour expliquer une mort au démarrage. */
const STDERR_TAIL_CHARS = 4_000

export class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly reader: Interface
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private closed = false
  private stderrTail = ''

  constructor(private readonly options: AcpClientOptions) {
    const launch = launchOf(options.binary)
    this.child = spawn(launch.command, [...launch.args, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS)
      process.stderr.write(`[${options.label}] ${text}`)
    })

    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.reader.on('line', (line) => this.handleLine(line))

    this.child.on('exit', (code) => {
      this.fail(new Error(`${options.label} s'est arrêté (code ${code ?? 'inconnu'}).`), code)
    })
    this.child.on('error', (error) => this.fail(error))
    this.child.stdin.on('error', (error) => this.fail(error))
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  private fail(error: Error, code: number | null = null): void {
    if (this.closed) return
    this.closed = true
    this.reader.close()
    this.child.kill()
    this.rejectAll(error)
    this.options.onExit?.(code, this.stderrTail)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return

    let message: { id?: RpcId | null; method?: string; params?: unknown; result?: unknown; error?: unknown }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid RPC object')
      message = parsed as typeof message
      if (message.method !== undefined && typeof message.method !== 'string') throw new Error('Invalid RPC method')
    } catch {
      process.stderr.write(`[${this.options.label}] ligne non JSON ignorée : ${line.slice(0, 200)}\n`)
      return
    }

    const hasId = message.id !== undefined && message.id !== null
    if (hasId && message.method === undefined) {
      if (typeof message.id !== 'number') return // Nos appels utilisent des ids numériques.
      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)
      if (call.timer) clearTimeout(call.timer)
      if (message.error !== undefined) {
        const error = message.error as { message?: string; code?: number; data?: unknown } | null
        call.reject(new AcpRpcError(
          error?.message ?? JSON.stringify(message.error), error?.code ?? -32000, error?.data,
        ))
      } else call.resolve(message.result ?? null)
      return
    }

    if (message.method !== undefined && hasId) {
      void this.answerRequest(message.id as RpcId, message.method, message.params)
      return
    }

    if (message.method !== undefined) this.options.onNotification?.(message.method, message.params)
  }

  private async answerRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    const handler = this.options.onRequest
    if (!handler) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (err) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: {
          code: err instanceof AcpRpcError ? err.code : -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  private write(payload: unknown): void {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /**
   * Appel d'une méthode de l'agent. `timeoutMs: null` pour celles qui durent le temps
   * qu'il faut, `session/prompt` d'abord : la réponse n'arrive qu'à la fin du tour.
   */
  request<T>(method: string, params: unknown, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`Le client ${this.options.label} est fermé.`))

    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === null
        ? null
        : setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`Délai dépassé sur ${method}.`))
          }, timeoutMs)
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Poignée de main. Le client ne déclare ni système de fichiers ni terminal : l'agent
   * garde ses propres outils, qui lisent et écrivent sur le disque du serveur, là même
   * où Sillage les lirait pour lui. Les déléguer ne ferait que doubler le trajet.
   */
  initialize(clientInfo: { name: string; title?: string; version: string }): Promise<InitializeResponse> {
    const params: InitializeRequest = {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo,
    }
    return this.request<InitializeResponse>('initialize', params)
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) {
      if (call.timer) clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.reader.close()
    // stdin fermé d'abord : un agent ACP s'arrête proprement à la fin de son entrée,
    // ce qui lui laisse écrire sa session sur disque. Le signal suit, pour celui qui
    // traînerait.
    this.child.stdin.end()
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }, 2_000).unref()
    this.rejectAll(new Error(`Client ${this.options.label} fermé.`))
  }
}
