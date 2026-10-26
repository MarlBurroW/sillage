import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiTokenRow, UserRow } from '@sillage/db'
import { resolveEntry } from '../../agents/mcp-builtin.js'
import type { AppContext } from '../context.js'
import { HttpError, badRequest, notFound, unauthorized, forbidden } from '../errors.js'
import { apiTokenToDto } from '../../auth/api-tokens.js'
import { TOOL_OPERATIONS, callOperation, operationTools } from './tool-operations.js'
import { allowedProjectIds } from './access.js'

/**
 * Sillage's MCP server over HTTP for clients outside this machine.
 *
 * The server itself (`mcp/sillage-mcp.mjs`) uses stdio and reads the database; it
 * knows nothing about networking. This bridge exposes MCP's streamable HTTP
 * transport under `/api/v1/mcp`, protected by API tokens. Scopes select actions, independently of transport.
 * Project tools run in a global-mode process as the token owner, limited to their
 * projects. Task tools call the existing REST handlers. Both the REST tool route
 * and MCP use the same catalog and dispatcher.
 *
 * Responses always use JSON, never streams: the server pushes nothing, and both
 * CLIs support either format. Clients call `initialize`, receive a `Mcp-Session-Id`,
 * then present it on subsequent requests. Missing or expired IDs return 404,
 * telling clients to initialize again as required by the transport.
 */

/** Stop the process after this idle timeout; the client can open a new session. */
const IDLE_MS = 30 * 60 * 1000
const REAP_EVERY_MS = 60 * 1000
/** Longer than server-side `start_session` (90 s), which itself waits for the daemon. */
const REPLY_TIMEOUT_MS = 120 * 1000
const MAX_SESSIONS_PER_TOKEN = 4

export interface JsonRpcMessage {
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
    readonly transport: 'mcp' | 'rest',
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
        waiting.resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: `MCP server stopped (code ${code ?? 'unknown'}).` } })
      }
      this.pending.clear()
      onExit(this)
    })
  }

  get alive(): boolean {
    return !this.closed
  }

  /** Forwards a message; returns responses to requests and nothing for notifications. */
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
        resolve({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'MCP server did not respond in time.' } })
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
  private readonly restSessions = new Map<string, McpSession>()
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
   * Global-mode server process running as the token owner. Allowed projects come
   * from the token; the server also checks what that account can see.
   */
  open(token: ApiTokenRow, user: UserRow, transport: 'mcp' | 'rest' = 'mcp'): McpSession {
    // One reusable REST worker per key avoids process churn and never evicts an MCP client.
    const existing = transport === 'rest' ? this.restSessions.get(token.id) : undefined
    if (existing?.alive) return existing
    const owned = [...this.sessions.values()].filter((session) => session.tokenId === token.id && session.transport === transport)
    // Reinitializing without closing would accumulate processes: evict the oldest.
    while (owned.length >= MAX_SESSIONS_PER_TOKEN) owned.shift()!.close()

    const child = spawn(process.execPath, [resolveEntry()], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SILLAGE_MCP_DB: this.ctx.config.paths.database,
        SILLAGE_MCP_USER: user.username,
        SILLAGE_MCP_TOKEN_ID: token.id,
        SILLAGE_MCP_MEMORY: this.ctx.config.paths.memory,
        SILLAGE_MCP_PROJECTS: allowedProjectIds(token).join(','),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const session = new McpSession(token.id, transport, child, (ended) => {
      this.sessions.delete(ended.id)
      if (this.restSessions.get(token.id) === ended) this.restSessions.delete(token.id)
    }, this.log)
    this.sessions.set(session.id, session)
    if (transport === 'rest') this.restSessions.set(token.id, session)
    return session
  }

  /** Session from the header, provided it belongs to the token presenting it. */
  lookup(id: string | undefined, token: ApiTokenRow): McpSession | null {
    if (!id) return null
    const session = this.sessions.get(id)
    return session && session.alive && session.transport === 'mcp' && session.tokenId === token.id ? session : null
  }

  close(session: McpSession): void {
    session.close()
    this.sessions.delete(session.id)
    if (this.restSessions.get(session.tokenId) === session) this.restSessions.delete(session.tokenId)
  }
}

function requireToken(request: FastifyRequest) {
  if (!request.apiToken || !request.user) throw unauthorized()
  return { token: request.apiToken, user: request.user }
}

function sessionHeader(request: FastifyRequest): string | undefined {
  const value = request.headers['mcp-session-id']
  return Array.isArray(value) ? value[0] : value
}

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): McpBridge {
  const bridge = new McpBridge(ctx, app.log)
  bridge.start()
  app.addHook('onClose', async () => bridge.stop())

  const scopesFor = (request: FastifyRequest): string[] => JSON.parse(requireToken(request).token.scopes)
  const listTools = async (request: FastifyRequest, session: McpSession) => {
    const scopes = scopesFor(request)
    const legacy = scopes.includes('mcp') ? await session.send({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' }) : null
    const tools = ((legacy?.result as { tools?: { name: string; description: string; inputSchema: { properties?: Record<string, object> } }[] } | undefined)?.tools ?? []).map((tool) => {
      if (!['start_session', 'schedule_task', 'create_automation'].includes(tool.name)) return tool
      return { ...tool, description: tool.name === 'start_session'
        ? 'Start a Sillage session in the selected project. Supply a self-contained prompt and optionally a CLI, model, reasoning effort, worktree or board card. Omitted choices use the key defaults; all choices must satisfy inspect_access. Returns the session ID; use read_session or wait_for_session to follow it.'
        : `${tool.description} For this access key, omitted choices use its defaults; CLI, model and effort must satisfy inspect_access.`,
        inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
          agent: { type: 'string', description: 'Authorized CLI. Omit for this key’s default; see inspect_access.' },
          model: { type: 'string', description: 'Authorized model ID or display name; see list_models. Omit for this key’s default.' },
          effort: { type: 'string', description: 'Authorized reasoning effort. Omit for defaults. max selects the model’s highest supported level, subject to key permissions.' },
        } } }
    })
    return { tools: [...tools, ...operationTools(scopes)] }
  }
  const callTool = async (request: FastifyRequest, session: McpSession | null, name: string, args: Record<string, unknown>) => {
    const operation = TOOL_OPERATIONS.find((entry) => entry.name === name)
    if (operation) return callOperation(app, request, operation, args)
    if (!scopesFor(request).includes('mcp')) throw forbidden('scope_missing', 'This token is missing the mcp scope.')
    if (!session) throw badRequest('tool_unavailable', 'Tool unavailable.')
    const response = await session.send({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } })
    if (response?.error) throw badRequest('tool_call_failed', JSON.stringify(response.error))
    return response?.result
  }
  // Both transports use these handlers, so every published tool has identical permissions.
  app.get('/api/v1/access', async (request) => {
    const { token } = requireToken(request)
    const dto = apiTokenToDto(token)
    return { scopes: dto.scopes, projectIds: dto.projectIds, executionPolicy: dto.executionPolicy, defaults: { agent: dto.agent, config: dto.config } }
  })
  app.get('/api/v1/tools', async (request) => {
    const { token, user } = requireToken(request)
    if (!scopesFor(request).includes('mcp')) return { tools: operationTools(scopesFor(request)) }
    return listTools(request, bridge.open(token, user, 'rest'))
  })
  app.post('/api/v1/tools/:name', async (request) => {
    const { token, user } = requireToken(request)
    const { name } = request.params as { name: string }
    const args = request.body ?? {}
    if (typeof args !== 'object' || Array.isArray(args)) throw badRequest('tool_arguments_invalid', 'Tool arguments must be an object.')
    if (TOOL_OPERATIONS.some((entry) => entry.name === name)) return callTool(request, null, name, args as Record<string, unknown>)
    if (!scopesFor(request).includes('mcp')) throw forbidden('scope_missing', 'This token is missing the mcp scope.')
    return callTool(request, bridge.open(token, user, 'rest'), name, args as Record<string, unknown>)
  })

  app.post('/api/v1/mcp', async (request, reply) => {
    const { token, user } = requireToken(request)
    const body = request.body as JsonRpcMessage | JsonRpcMessage[] | undefined
    if (!body || typeof body !== 'object') throw badRequest('mcp_invalid_body', 'A JSON-RPC message is required.')
    if (Array.isArray(body)) throw badRequest('mcp_batch_unsupported', 'JSON-RPC batches are not supported.')

    if ((body.method === 'tools/call' || body.method === 'tools/list') && body.id == null) {
      throw badRequest('mcp_request_id_required', 'Tool requests require an id.')
    }

    if (body.method === 'initialize') {
      const session = bridge.open(token, user)
      const response = await session.send(body)
      return reply.header('Mcp-Session-Id', session.id).send(response)
    }

    const session = bridge.lookup(sessionHeader(request), token)
    if (!session) throw notFound('mcp_session_not_found', 'MCP session not found: send initialize first.')
    session.lastUsed = Date.now()
    let response: JsonRpcMessage | null
    if (body.method === 'tools/list' && body.id != null) {
      response = { jsonrpc: '2.0', id: body.id, result: await listTools(request, session) }
    } else if (body.method === 'tools/call' && body.id != null) {
      const params = body.params as { name?: unknown; arguments?: unknown } | undefined
      if (typeof params?.name !== 'string' || (params.arguments != null && (typeof params.arguments !== 'object' || Array.isArray(params.arguments)))) {
        throw badRequest('tool_arguments_invalid', 'A tool name and object arguments are required.')
      }
      try {
        response = { jsonrpc: '2.0', id: body.id, result: await callTool(request, session, params.name, (params.arguments ?? {}) as Record<string, unknown>) }
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        response = { jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message, params: error.params } }) }] } }
      }
    } else {
      response = await session.send(body)
    }
    if (response === null) return reply.status(202).send()
    return reply.header('Mcp-Session-Id', session.id).send(response)
  })

  app.delete('/api/v1/mcp', async (request, reply) => {
    const { token } = requireToken(request)
    const session = bridge.lookup(sessionHeader(request), token)
    if (!session) throw notFound('mcp_session_not_found', 'MCP session not found.')
    bridge.close(session)
    return reply.status(204).send()
  })

  // The transport supports a downstream GET stream; this server pushes nothing.
  app.get('/api/v1/mcp', async (request: FastifyRequest) => {
    requireToken(request)
    throw new HttpError(405, 'mcp_no_stream', 'This server does not open server-to-client streams.')
  })

  return bridge
}
