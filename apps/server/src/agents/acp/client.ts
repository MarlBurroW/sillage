import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { launchOf } from '../launch.js'
import { createInterface, type Interface } from 'node:readline'
import type { InitializeRequest, InitializeResponse } from '@agentclientprotocol/sdk'

/** Newline-delimited stdio JSON-RPC Agent Client Protocol used by editors such as Zed and Grok's `grok agent stdio`. Handwritten transport with official SDK types rather than `ClientSideConnection`, whose zod validation would reject agent-specific session/update variants (`_x.ai/…`) instead of showing unknown notices once. Like Codex app-server: minimal transport without business logic; runners decide translations. */

/** Default request timeout; turn-long `session/prompt` has none. */
const REQUEST_TIMEOUT_MS = 30_000

/** Retains RPC codes: agent rejections are not transport failures. */
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
  /** Short CLI name prefixing stderr logs. */
  label: string
  binary: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Agent notifications (session/update and its underscore-prefixed extensions). */
  onNotification?: (method: string, params: unknown) => void
  /** Agent requests needing replies: `session/request_permission` and unsupported capabilities. Exceptions become RPC errors. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>
  /** Unexpected process death outside requested `close()`; see `CodexClientOptions.onExit`. */
  onExit?: (code: number | null, stderrTail: string) => void
  /** Login services consume OAuth URLs privately instead of logging them. */
  onStderr?: (text: string) => void
}

/** Retained stderr explaining startup deaths. */
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
      if (options.onStderr) options.onStderr(text)
      else process.stderr.write(`[${options.label}] ${text}`)
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
      if (typeof message.id !== 'number') return // Our requests use numeric IDs.
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

  /** Calls agent methods. `timeoutMs: null` permits unbounded requests, notably `session/prompt`, whose response arrives only at turn completion. */
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

  /** Handshake advertises neither filesystem nor terminals: agents retain native tools on the same server disk Sillage would access, avoiding redundant delegation round trips. */
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
    // Close stdin first so ACP agents persist sessions and shut down gracefully;
    // signals follow for agents that
    // linger.
    this.child.stdin.end()
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }, 2_000).unref()
    this.rejectAll(new Error(`Client ${this.options.label} fermé.`))
  }

  /** Native SQLite histories must be closed before another account resumes them. */
  async closeAndWait(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) { this.close(); return }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000)
      this.child.once('close', () => { clearTimeout(timer); resolve() })
      this.close()
    })
  }
}
