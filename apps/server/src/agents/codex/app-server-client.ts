import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type {
  ClientRequest,
  InitializeParams,
  InitializeResponse,
  RequestId,
} from '@sillage/codex-bindings'

/**
 * Méthodes et paramètres tirés de l'union générée : un nom de méthode inexistant ou
 * des paramètres du mauvais type ne compilent pas. Le protocole ne se retranscrit
 * donc jamais à la main, il se cite.
 *
 * Les types de réponse ne sont pas indexés par méthode dans les bindings, l'appelant
 * les précise donc explicitement (`call<ModelListResponse>(...)`).
 */
export type CodexMethod = ClientRequest['method']
export type CodexParams<M extends CodexMethod> = Extract<ClientRequest, { method: M }>['params']

/**
 * Client JSON-RPC de `codex app-server`, sur stdio et délimité par des sauts de ligne.
 *
 * Volontairement minimal et sans logique métier : l'adaptateur Codex du lot 2 s'appuie
 * dessus pour les tours de conversation, le catalogue de modèles s'en sert pour un
 * simple `model/list`. Les types des paramètres viennent des bindings générés, jamais
 * d'une transcription à la main du protocole.
 */

const REQUEST_TIMEOUT_MS = 30_000

/** Conserve le code RPC : un refus du CLI n'est pas une panne de transport. */
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
  /** Notifications serveur (`item/started`, `turn/completed`...). */
  onNotification?: (method: string, params: unknown) => void
  /** Requêtes serveur à répondre, dont les demandes d'approbation. */
  onServerRequest?: (method: string, params: unknown, requestId: RequestId) => Promise<unknown>
  /**
   * Mort du process hors d'un `close()` demandé. Sans ce signal, une conversation
   * sans requête en vol resterait `running` pour toujours : rejeter les appels en
   * attente ne prévient personne quand il n'y en a aucun.
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
    this.child = spawn(options.binary, ['app-server'], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Le sandbox Linux de Codex se plaint bruyamment sur les hôtes sans espaces de
    // noms utilisateur. C'est un diagnostic, pas un événement de conversation.
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
      // Le CLI écrit parfois des lignes non JSON sur stdout au démarrage. Les ignorer
      // en silence masquerait un vrai problème de protocole, on les signale.
      process.stderr.write(`[codex] ligne non JSON ignorée : ${line.slice(0, 200)}\n`)
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      if (typeof message.id !== 'number') return // Nos appels utilisent des ids numériques.
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
      // Le serveur peut annuler une question pendant que l'utilisateur la lit.
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
   * Appel d'une méthode ou d'un champ que `experimentalApi` débloque.
   *
   * `codex app-server generate-ts` n'exporte pas ces méthodes, donc elles ne sont pas
   * dans l'union générée et `call` les refuserait. Le nom est explicite pour que ce
   * contournement reste visible : tout ce qui passe par ici est susceptible de
   * disparaître à la prochaine version du CLI, contrairement au reste du protocole,
   * dont la dérive est détectée par `pnpm codex:types:check`.
   */
  callExperimental<T>(method: string, params: unknown): Promise<T> {
    return this.call<T, CodexMethod>(method as CodexMethod, params as CodexParams<CodexMethod>)
  }

  async initialize(clientInfo: InitializeParams['clientInfo']): Promise<InitializeResponse> {
    const result = await this.call<InitializeResponse, 'initialize'>('initialize', {
      clientInfo,
      // `experimentalApi` conditionne le mode de collaboration : sans elle,
      // `turn/start.collaborationMode` est rejeté et le mode Plan est inatteignable.
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
