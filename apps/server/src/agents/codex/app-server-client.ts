import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { launchOf } from '../launch.js'
import { createInterface, type Interface } from 'node:readline'
import type {
  ClientRequest,
  InitializeParams,
  InitializeResponse,
  RequestId,
} from '@sillage/codex-bindings'

/**
 * Methods and parameters come from the generated union: nonexistent methods or incorrect parameter
 * types fail compilation. Reference the protocol rather than transcribing it manually. Response
 * types are not indexed by method in bindings, so callers specify them explicitly
 * (call<ModelListResponse>(...)).
 */
export type CodexMethod = ClientRequest['method']
export type CodexParams<M extends CodexMethod> = Extract<ClientRequest, { method: M }>['params']

/**
 * Newline-delimited stdio JSON-RPC client for codex app-server. Deliberately minimal, without
 * business logic: the batch-2 adapter uses it for conversation turns, while catalogs only need
 * model/list. Parameter types always come from generated bindings, never manual protocol
 * transcription.
 */

const REQUEST_TIMEOUT_MS = 30_000

/** Preserve RPC codes: CLI rejection is not transport failure. */
export class CodexRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface CodexClientOptions {
  binary: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Server notifications such as item/started and turn/completed. */
  onNotification?: (method: string, params: unknown) => void
  /** Server requests needing replies, including approvals. */
  onServerRequest?: (method: string, params: unknown, requestId: RequestId) => Promise<unknown>
  /**
   * Unexpected process death outside requested close calls. Without this signal, conversations
   * without in-flight requests would remain running forever: rejecting pending calls notifies
   * nobody when none exist.
   */
  onExit?: (code: number | null) => void
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly reader: Interface
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private closed = false
  private readonly serverRequests = new Set<RequestId>()

  constructor(private readonly options: CodexClientOptions) {
    const launch = launchOf(options.binary)
    this.child = spawn(launch.command, [...launch.args, 'app-server'], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    // Codex Linux sandbox complains loudly on hosts lacking user
    // namespaces. This is diagnostic output, not conversation events.
    this.child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[codex] ${chunk.toString()}`)
    })

    this.reader = createInterface({ input: this.child.stdout })
    this.reader.on('line', (line) => this.handleLine(line))

    this.child.on('exit', (code) => {
      this.fail(new Error(`codex app-server s'est arrêté (code ${code ?? 'inconnu'}).`), code)
    })
    this.child.on('error', (error) => this.fail(error))
    this.child.stdin.on('error', (error) => this.fail(error))
  }

  private fail(error: Error, code: number | null = null): void {
    if (this.closed) return
    this.closed = true
    this.reader.close()
    this.child.kill()
    this.serverRequests.clear()
    this.rejectAll(error)
    this.options.onExit?.(code)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return

    let message: { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: unknown }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid RPC object')
      message = parsed as typeof message
      if ((message.method !== undefined && typeof message.method !== 'string') ||
          (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number')) {
        throw new Error('Invalid RPC envelope')
      }
    } catch {
      // CLI startup occasionally writes non-JSON stdout lines. Ignoring them
      // silently could hide actual protocol issues, so report them.
      process.stderr.write(`[codex] ligne non JSON ignorée : ${line.slice(0, 200)}\n`)
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      if (typeof message.id !== 'number') return // Our calls use numeric IDs.
      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error !== undefined) {
        const error = message.error as { message?: string; code?: number; data?: unknown } | null
        call.reject(new CodexRpcError(
          error?.message ?? JSON.stringify(message.error), error?.code ?? -32000, error?.data,
        ))
      } else call.resolve(message.result)
      return
    }

    if (message.method !== undefined && message.id !== undefined) {
      this.serverRequests.add(message.id)
      void this.answerServerRequest(message.id, message.method, message.params)
      return
    }

    if (message.method !== undefined) {
      if (message.method === 'serverRequest/resolved') {
        const resolved = message.params as { requestId?: RequestId } | undefined
        if (resolved?.requestId !== undefined) this.serverRequests.delete(resolved.requestId)
      }
      this.options.onNotification?.(message.method, message.params)
    }
  }

  private async answerServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    const handler = this.options.onServerRequest
    if (!handler) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Requête serveur non gérée : ${method}` },
      })
      this.serverRequests.delete(id)
      return
    }

    try {
      const result = await handler(method, params, id)
      // Servers may cancel questions while users read them.
      if (this.serverRequests.delete(id)) this.write({ jsonrpc: '2.0', id, result })
    } catch (err) {
      if (!this.serverRequests.delete(id)) return
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: err instanceof CodexRpcError ? err.code : -32000, message: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private write(payload: unknown): void {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  call<T, M extends CodexMethod = CodexMethod>(method: M, params: CodexParams<M>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Le client Codex est fermé.'))

    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Délai dépassé sur ${method}.`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * Call methods or fields enabled by experimentalApi. generate-ts omits them from the generated
   * union, so ordinary call rejects them. Explicit naming keeps this bypass visible: these features
   * may disappear next CLI release, unlike protocol drift detected by pnpm codex:types:check.
   */
  callExperimental<T>(method: string, params: unknown): Promise<T> {
    return this.call<T, CodexMethod>(method as CodexMethod, params as CodexParams<CodexMethod>)
  }

  async initialize(clientInfo: InitializeParams['clientInfo']): Promise<InitializeResponse> {
    const result = await this.call<InitializeResponse, 'initialize'>('initialize', {
      clientInfo,
      // experimentalApi gates collaboration mode: without it,
      // turn/start.collaborationMode is rejected and Plan mode is unreachable.
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        extensions: { 'openai/form': {} },
      },
    })
    this.write({ jsonrpc: '2.0', method: 'initialized', params: {} })
    return result
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    this.pending.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.serverRequests.clear()
    this.reader.close()
    this.child.kill()
    this.rejectAll(new Error('Client Codex fermé.'))
  }
}
