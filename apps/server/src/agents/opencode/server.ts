import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { launchOf } from '../launch.js'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type { Config, Event } from '@sillage/opencode-bindings'
import { assertSupportedOpencode } from './version-guard.js'

/**
 * opencode serve and HTTP client.
 *
 * No stdio protocol like Codex: HTTP API, SSE GET /event. Module owns process/requests/stream
 * without business logic, like CodexAppServerClient.
 *
 * First API only (/session/..., GET /event), probed 1.18.25/1.19.0/1.19.3. Second
 * (/api/session/..., GET /api/event) ignores first sessions and lacks forks/MCP.
 */

const START_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000
/** Stream reconnect attempts before declaring server lost. */
const MAX_STREAM_RETRIES = 5

/** Preserve HTTP status: opencode rejection is not transport failure. */
export class OpencodeHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message)
    this.name = 'OpencodeHttpError'
  }
}

export interface OpencodeServerOptions {
  binary: string
  cwd: string
  env?: NodeJS.ProcessEnv
  /**
   * OPENCODE_CONFIG_CONTENT injected over machine config. Only per-conversation channel: POST /mcp
   * etc affect whole instance; user files untouched.
   */
  config: Config
  /** Stream events. Without handler stream stays unopened: probes do not need it. */
  onEvent?: (event: Event) => void
  /**
   * Reconnected stream after interruption. Events during gap lost; caller must reread tracked
   * state.
   */
  onReconnect?: () => void
  /** Unexpected process death or permanently lost stream outside requested close(). */
  onExit?: (code: number | null) => void
}

export class OpencodeServer {
  private closed = false
  /** Close current stream connection, one per attachment. */
  private connection = new AbortController()
  /** reloadInstance-requested reconnect, resolved at first event. */
  private restart: (() => void) | null = null

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly baseUrl: string,
    private readonly authorization: string,
    private readonly options: OpencodeServerOptions,
  ) {}

  /**
   * Start server, wait for listening with stream connected.
   *
   * Choose port here: --port 0 picks 4096 when apparently free, even while previous conversation
   * server shuts down. Observed settings restart: new server announced 4096, first connection cut.
   * Per-process password prevents any local program driving session through port.
   */
  static async start(options: OpencodeServerOptions): Promise<OpencodeServer> {
    // Single launch point for sessions/catalog/commands/forks: reject opencode 2 everywhere rather
    // than run silently.
    await assertSupportedOpencode(options.binary)
    const password = randomBytes(24).toString('hex')
    const port = await freePort()
    const launch = launchOf(options.binary)
    const child = spawn(launch.command, [...launch.args, 'serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      windowsHide: true,
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let baseUrl: string
    try {
      baseUrl = await listeningUrl(child)
    } catch (err) {
      child.kill()
      throw err
    }

    // After announcement output serves diagnostics only.
    const relay = (chunk: Buffer) => process.stderr.write(`[opencode] ${chunk.toString()}`)
    child.stdout.on('data', relay)
    child.stderr.on('data', relay)

    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    const server = new OpencodeServer(child, baseUrl, authorization, options)
    child.on('exit', (code) => server.fail(code))
    child.on('error', () => server.fail(null))

    if (options.onEvent) {
      try {
        await server.openStream()
      } catch (err) {
        server.close()
        throw err
      }
    }
    return server
  }

  private fail(code: number | null): void {
    if (this.closed) return
    this.closed = true
    this.connection.abort()
    this.child.kill()
    this.options.onExit?.(code)
  }

  /** Connect stream, return at first server.connected: earlier requests would lose initial events. */
  private async openStream(): Promise<void> {
    const body = await this.connectStream()
    let connected!: () => void
    const ready = new Promise<void>((resolve) => { connected = resolve })
    void this.consume(body, connected)
    await ready
  }

  private async connectStream(): Promise<ReadableStream<Uint8Array>> {
    this.connection = new AbortController()
    const response = await fetch(`${this.baseUrl}/event`, {
      headers: { accept: 'text/event-stream', authorization: this.authorization },
      signal: this.connection.signal,
    })
    if (!response.ok || !response.body) {
      throw new OpencodeHttpError(`GET /event a répondu ${response.status}.`, response.status, null)
    }
    return response.body
  }

  private async consume(first: ReadableStream<Uint8Array>, connected: () => void): Promise<void> {
    let body = first
    let retries = 0
    let onFirstFrame = connected
    while (!this.closed) {
      try {
        await this.readFrames(body, () => {
          retries = 0
          onFirstFrame()
        })
      } catch {
        // Stream failure treated as end, followed by reconnect.
      }
      if (this.closed) return

      // Stream silent but process alive: reconnect rather than lose session; after attempts declare
      // server lost. Requested disconnection neither counts as failure nor waits.
      if (this.restart === null) {
        if (++retries > MAX_STREAM_RETRIES) return this.fail(null)
        await new Promise((resolve) => setTimeout(resolve, 200 * retries))
        if (this.closed) return
      }
      try {
        body = await this.connectStream()
      } catch {
        // Retry next iteration with longer delay.
        body = new ReadableStream({ start: (controller) => controller.close() })
        continue
      }
      const requested = this.restart
      this.restart = null
      onFirstFrame = requested ?? (() => {})
      if (!requested) this.options.onReconnect?.()
    }
  }

  /**
   * Reload config through POST /instance/dispose: skills/agents/commands. Database sessions
   * unaffected.
   *
   * Probed: existing stream stays attached to disposed instance, silently open.
   * Disconnect/reconnect, wait first event like startup. Idle only: active turns die with instance.
   */
  async reloadInstance(): Promise<void> {
    await this.post('/instance/dispose')
    if (!this.options.onEvent || this.closed) return
    await new Promise<void>((resolve) => {
      this.restart = resolve
      this.connection.abort()
    })
  }

  /** SSE frames: data: lines terminated by blank line. Ignore rest. */
  private async readFrames(body: ReadableStream<Uint8Array>, onFrame: () => void): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue

        let event: Event
        try {
          event = JSON.parse(data) as Event
        } catch {
          process.stderr.write(`[opencode] trame SSE illisible ignorée : ${data.slice(0, 200)}\n`)
          continue
        }
        onFrame()
        this.options.onEvent?.(event)
      }
    }
  }

  /**
   * JSON request. Null timeoutMs for turn-duration /command,/summarize: limiting would cut
   * responses returned only at end.
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs: number | null = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) throw new Error('Le serveur opencode est fermé.')

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: this.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
    })

    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    if (!response.ok) {
      throw new OpencodeHttpError(describeFailure(method, path, response.status, parsed), response.status, parsed)
    }
    return parsed as T
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  post<T>(path: string, body: unknown = {}, timeoutMs?: number | null): Promise<T> {
    return this.request<T>('POST', path, body, timeoutMs)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.connection.abort()
    // Pending reload must not hang on stream that will never arrive.
    this.restart?.()
    this.child.kill()
  }
}

/**
 * Free port requested from system then released, not reserved: if another process takes it,
 * opencode startup fails visibly.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('Aucun port libre obtenu du système.'))
      })
    })
  })
}

/** Address announced by opencode (“opencode server listening on http://…”). */
function listeningUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', read)
      child.stderr.off('data', read)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /listening on (http:\/\/\S+)/.exec(output)
      if (!match?.[1]) return
      cleanup()
      resolve(match[1])
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`opencode serve s'est arrêté au démarrage (code ${code ?? 'inconnu'}). ${output.trim().slice(-400)}`))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`opencode serve n'a pas annoncé son adresse. ${output.trim().slice(-400)}`))
    }, START_TIMEOUT_MS)

    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}

/** opencode errors carry message under data.message or at top level. */
function describeFailure(method: string, path: string, status: number, body: unknown): string {
  const fields = body as { data?: { message?: unknown }; message?: unknown } | null
  const detail = fields?.data?.message ?? fields?.message
  return typeof detail === 'string' && detail
    ? detail
    : `${method} ${path.split('?')[0]} a répondu ${status}.`
}
