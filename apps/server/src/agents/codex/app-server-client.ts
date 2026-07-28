import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type {
  ClientRequest,
  InitializeParams,
  InitializeResponse,
} from '@sillage/protocol/codex'

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
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>
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
      const expected = this.closed
      this.closed = true
      this.rejectAll(new Error(`codex app-server s'est arrêté (code ${code ?? 'inconnu'}).`))
      if (!expected) this.options.onExit?.(code)
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return

    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      // Le CLI écrit parfois des lignes non JSON sur stdout au démarrage. Les ignorer
      // en silence masquerait un vrai problème de protocole, on les signale.
      process.stderr.write(`[codex] ligne non JSON ignorée : ${line.slice(0, 200)}\n`)
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error !== undefined) call.reject(new Error(JSON.stringify(message.error)))
      else call.resolve(message.result)
      return
    }

    if (message.method !== undefined && message.id !== undefined) {
      void this.answerServerRequest(message.id, message.method, message.params)
      return
    }

    if (message.method !== undefined) {
      this.options.onNotification?.(message.method, message.params)
    }
  }

  private async answerServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.options.onServerRequest
    if (!handler) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Requête serveur non gérée : ${method}` },
      })
      return
    }

    try {
      this.write({ jsonrpc: '2.0', id, result: await handler(method, params) })
    } catch (err) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
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
    this.write({ jsonrpc: '2.0', id, method, params })

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

  initialize(clientInfo: InitializeParams['clientInfo']): Promise<InitializeResponse> {
    return this.call<InitializeResponse, 'initialize'>('initialize', {
      clientInfo,
      // `experimentalApi` conditionne le mode de collaboration : sans elle,
      // `turn/start.collaborationMode` est rejeté et le mode Plan est inatteignable.
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
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
    this.reader.close()
    this.child.kill()
    this.rejectAll(new Error('Client Codex fermé.'))
  }
}
