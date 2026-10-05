import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import type { Config, Event } from '@sillage/opencode-bindings'

/**
 * Un `opencode serve` et le client HTTP qui lui parle.
 *
 * opencode n'a pas de protocole sur stdio comme l'app-server de Codex : il ouvre une API
 * HTTP et pousse ses événements par SSE (`GET /event`). Ce module tient les trois bouts
 * (le process, les requêtes, le flux) et rien du métier, comme `CodexAppServerClient`.
 *
 * Première génération de l'API seulement (`/session/...`, `GET /event`). Sondé sur
 * opencode 1.18.25 : la seconde (`/api/session/...`, `GET /api/event`) est un monde à
 * part, son flux ne dit rien des sessions créées par la première, et il lui manque le
 * fork et les serveurs MCP.
 */

const START_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000
/** Tentatives de rebranchement du flux avant de déclarer le serveur perdu. */
const MAX_STREAM_RETRIES = 5

/** Conserve le statut HTTP : un refus d'opencode n'est pas une panne de transport. */
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
   * Configuration injectée par `OPENCODE_CONFIG_CONTENT`, fusionnée par-dessus celle du
   * poste. C'est le seul canal par conversation : `POST /mcp` et le reste agissent sur
   * l'instance entière, et rien n'est écrit dans les fichiers de l'utilisateur.
   */
  config: Config
  /** Événements du flux. Absent, le flux n'est pas ouvert : une sonde n'en a pas besoin. */
  onEvent?: (event: Event) => void
  /**
   * Le flux a été rebranché après une coupure. Ce qui s'est dit entre-temps est perdu :
   * à l'appelant de relire l'état qu'il suit.
   */
  onReconnect?: () => void
  /** Mort du process, ou flux définitivement perdu, hors d'un `close()` demandé. */
  onExit?: (code: number | null) => void
}

export class OpencodeServer {
  private closed = false
  /** Coupe la connexion courante du flux ; une par branchement. */
  private connection = new AbortController()
  /** Rebranchement demandé par `reloadInstance`, à résoudre au premier événement reçu. */
  private restart: (() => void) | null = null

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly baseUrl: string,
    private readonly authorization: string,
    private readonly options: OpencodeServerOptions,
  ) {}

  /**
   * Lance le serveur et attend qu'il écoute, flux branché.
   *
   * Le port est choisi ici et non laissé à opencode : avec `--port 0` il prend 4096
   * dès qu'il le croit libre, y compris pendant que le serveur précédent de la même
   * conversation finit de s'éteindre. Relevé en relançant un runner pour un réglage : le
   * nouveau annonçait 4096 et sa première connexion était coupée. Un mot de passe par
   * process : sans lui, n'importe quel programme de la machine piloterait la session
   * par ce port.
   */
  static async start(options: OpencodeServerOptions): Promise<OpencodeServer> {
    const password = randomBytes(24).toString('hex')
    const port = await freePort()
    const child = spawn(options.binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
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

    // Passé l'annonce, la sortie n'est plus qu'un diagnostic.
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

  /**
   * Branche le flux et rend la main à son premier événement (`server.connected`) :
   * une requête partie avant verrait ses premiers événements passer sans témoin.
   */
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
        // Coupure du flux : traitée comme une fin, le rebranchement suit.
      }
      if (this.closed) return

      // Le flux s'est tu alors que le process vit encore. On le rebranche plutôt que de
      // perdre la session ; au-delà de quelques essais, c'est le serveur qui est perdu.
      // Une coupure demandée ne compte pas comme une panne et n'attend pas.
      if (this.restart === null) {
        if (++retries > MAX_STREAM_RETRIES) return this.fail(null)
        await new Promise((resolve) => setTimeout(resolve, 200 * retries))
        if (this.closed) return
      }
      try {
        body = await this.connectStream()
      } catch {
        // Nouvel essai au tour suivant, avec un délai plus long.
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
   * Fait relire sa configuration à opencode (`POST /instance/dispose`) : dossiers de
   * skills, agents, commandes. Les sessions, en base, n'en souffrent pas.
   *
   * Sondé : le flux ouvert reste branché à l'instance jetée et ne dit plus rien, sans
   * se fermer. Il est donc coupé et rebranché ici, et la main n'est rendue qu'à son
   * premier événement, comme au lancement. À n'appeler qu'au repos : un tour en cours
   * partirait avec l'instance.
   */
  async reloadInstance(): Promise<void> {
    await this.post('/instance/dispose')
    if (!this.options.onEvent || this.closed) return
    await new Promise<void>((resolve) => {
      this.restart = resolve
      this.connection.abort()
    })
  }

  /** Trames SSE : des lignes `data:` closes par une ligne vide. Le reste est ignoré. */
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
   * Requête JSON. `timeoutMs` nul pour celles qui durent le temps d'un tour
   * (`/command`, `/summarize`) : les borner couperait une réponse qu'opencode ne
   * rend qu'à la fin.
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
    // Un rechargement en attente ne doit pas rester suspendu à un flux qui ne viendra plus.
    this.restart?.()
    this.child.kill()
  }
}

/**
 * Un port libre, pris au système puis rendu. Rien ne le réserve entre-temps : si un
 * autre process le prend, opencode échoue à démarrer et le lancement le dit.
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

/** L'adresse qu'opencode annonce (« opencode server listening on http://… »). */
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

/** Les erreurs d'opencode portent leur message sous `data.message`, ou à plat. */
function describeFailure(method: string, path: string, status: number, body: unknown): string {
  const fields = body as { data?: { message?: unknown }; message?: unknown } | null
  const detail = fields?.data?.message ?? fields?.message
  return typeof detail === 'string' && detail
    ? detail
    : `${method} ${path.split('?')[0]} a répondu ${status}.`
}
