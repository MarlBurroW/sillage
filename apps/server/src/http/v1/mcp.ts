import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiTokenRow, UserRow } from '@sillage/db'
import { resolveEntry } from '../../agents/mcp-builtin.js'
import type { AppContext } from '../context.js'
import { HttpError, badRequest, notFound } from '../errors.js'
import { requireScope } from '../require-user.js'
import { allowedProjectIds } from './access.js'

/**
 * Le serveur MCP de Sillage par HTTP, pour un client qui n'est pas sur la machine.
 *
 * Le serveur lui-même (`mcp/sillage-mcp.mjs`) parle en stdio et lit la base : il ne
 * sait rien du réseau. Ce pont l'expose selon le transport « streamable HTTP » de MCP,
 * sous `/api/v1/mcp`, donc derrière le jeton d'API et sa portée `mcp`. Il ne
 * réimplémente aucun outil : chaque session HTTP est un process du serveur en mode
 * global, lancé au nom du compte du jeton et borné à ses projets, et chaque requête
 * JSON-RPC lui est transmise telle quelle.
 *
 * Toujours une réponse JSON, jamais un flux : le serveur ne pousse rien au client, et
 * les deux CLI acceptent l'une comme l'autre. Le client enchaîne `initialize`, reçoit
 * un `Mcp-Session-Id`, et le présente ensuite ; sans lui, ou après expiration, 404,
 * ce qui lui dit de recommencer par `initialize`, comme le transport le prévoit.
 */

/** Sans requête depuis ce délai, le process est arrêté : le client rouvrira une session. */
const IDLE_MS = 30 * 60 * 1000
const REAP_EVERY_MS = 60 * 1000
/** Plus que `start_session` côté serveur (90 s), qui attend lui-même le daemon. */
const REPLY_TIMEOUT_MS = 120 * 1000
const MAX_SESSIONS_PER_TOKEN = 4

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

interface Pending {
  resolve: (message: JsonRpcMessage) => void
  timer: NodeJS.Timeout
}

class McpSession {
  readonly id = randomUUID()
  lastUsed = Date.now()
  private readonly pending = new Map<string, Pending>()
  private closed = false

  constructor(
    readonly tokenId: string,
    private readonly child: ChildProcess,
    onExit: (session: McpSession) => void,
    log: FastifyInstance['log'],
  ) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (!line.trim()) return
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch {
        return
      }
      const waiting = message.id === undefined || message.id === null ? null : this.pending.get(String(message.id))
      if (!waiting) return
      clearTimeout(waiting.timer)
      this.pending.delete(String(message.id))
      waiting.resolve(message)
    })
    createInterface({ input: child.stderr! }).on('line', (line) => log.debug({ mcpSession: this.id }, line))
    child.on('exit', (code) => {
      this.closed = true
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer)
        waiting.resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: `Le serveur MCP s'est arrêté (code ${code ?? 'inconnu'}).` } })
      }
      this.pending.clear()
      onExit(this)
    })
  }

  get alive(): boolean {
    return !this.closed
  }

  /** Transmet un message ; rend la réponse pour une requête, rien pour une notification. */
  send(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    this.lastUsed = Date.now()
    if (this.closed) throw notFound('mcp_session_closed', 'MCP session closed.')
    const line = `${JSON.stringify(message)}\n`
    if (message.id === undefined || message.id === null) {
      this.child.stdin!.write(line)
      return Promise.resolve(null)
    }
    const key = String(message.id)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        resolve({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Le serveur MCP n’a pas répondu à temps.' } })
      }, REPLY_TIMEOUT_MS)
      this.pending.set(key, { resolve, timer })
      this.child.stdin!.write(line)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.child.kill()
  }
}

export class McpBridge {
  private readonly sessions = new Map<string, McpSession>()
  private reaper: NodeJS.Timeout | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyInstance['log'],
  ) {}

  start(): void {
    this.reaper = setInterval(() => {
      const cutoff = Date.now() - IDLE_MS
      for (const session of this.sessions.values()) if (session.lastUsed < cutoff) session.close()
    }, REAP_EVERY_MS)
    this.reaper.unref()
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper)
    for (const session of this.sessions.values()) session.close()
  }

  /**
   * Un process du serveur en mode global, au nom du compte du jeton. Les projets
   * permis sont ceux du jeton ; le serveur y ajoute lui-même ce que le compte voit.
   */
  open(token: ApiTokenRow, user: UserRow): McpSession {
    const owned = [...this.sessions.values()].filter((session) => session.tokenId === token.id)
    // Un client qui réinitialise sans fermer accumulerait des process : le plus ancien part.
    while (owned.length >= MAX_SESSIONS_PER_TOKEN) owned.shift()!.close()

    const child = spawn(process.execPath, [resolveEntry()], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SILLAGE_MCP_DB: this.ctx.config.paths.database,
        SILLAGE_MCP_USER: user.username,
        SILLAGE_MCP_MEMORY: this.ctx.config.paths.memory,
        SILLAGE_MCP_PROJECTS: allowedProjectIds(token).join(','),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const session = new McpSession(token.id, child, (ended) => this.sessions.delete(ended.id), this.log)
    this.sessions.set(session.id, session)
    return session
  }

  /** La session de l'en-tête, si elle appartient au jeton qui la présente. */
  lookup(id: string | undefined, token: ApiTokenRow): McpSession | null {
    if (!id) return null
    const session = this.sessions.get(id)
    return session && session.alive && session.tokenId === token.id ? session : null
  }

  close(session: McpSession): void {
    session.close()
    this.sessions.delete(session.id)
  }
}

function sessionHeader(request: FastifyRequest): string | undefined {
  const value = request.headers['mcp-session-id']
  return Array.isArray(value) ? value[0] : value
}

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): McpBridge {
  const bridge = new McpBridge(ctx, app.log)
  bridge.start()
  app.addHook('onClose', async () => bridge.stop())

  app.post('/api/v1/mcp', async (request, reply) => {
    const { token, user } = requireScope(request, 'mcp')
    const body = request.body as JsonRpcMessage | JsonRpcMessage[] | undefined
    if (!body || typeof body !== 'object') throw badRequest('mcp_invalid_body', 'A JSON-RPC message is required.')
    if (Array.isArray(body)) throw badRequest('mcp_batch_unsupported', 'JSON-RPC batches are not supported.')

    if (body.method === 'initialize') {
      const session = bridge.open(token, user)
      const response = await session.send(body)
      return reply.header('Mcp-Session-Id', session.id).send(response)
    }

    const session = bridge.lookup(sessionHeader(request), token)
    if (!session) throw notFound('mcp_session_not_found', 'MCP session not found: send initialize first.')
    const response = await session.send(body)
    if (response === null) return reply.status(202).send()
    return reply.header('Mcp-Session-Id', session.id).send(response)
  })

  app.delete('/api/v1/mcp', async (request, reply) => {
    const { token } = requireScope(request, 'mcp')
    const session = bridge.lookup(sessionHeader(request), token)
    if (!session) throw notFound('mcp_session_not_found', 'MCP session not found.')
    bridge.close(session)
    return reply.status(204).send()
  })

  // Le transport prévoit un flux descendant sur GET ; ce serveur ne pousse rien.
  app.get('/api/v1/mcp', async (request: FastifyRequest) => {
    requireScope(request, 'mcp')
    throw new HttpError(405, 'mcp_no_stream', 'This server does not open server-to-client streams.')
  })

  return bridge
}
