import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { conversations, mcpServers, type ConversationRow, type Db } from '@sillage/db'
import {
  clearTextSecrets,
  isReservedMcpServerName,
  mcpInstallScopeSchema,
  mcpServerNameSchema,
  mcpTransportSchema,
  parseAgentConfig,
  referencedSecrets,
  type AnswerMcpInstallBody,
  type McpInstallScope,
  type McpTransport,
  type SillageEvent,
} from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { SecretStore } from '../secrets/store.js'
import type { SessionManager } from '../sessions/session-manager.js'
import { rowToMcpServer } from './mcp-registry.js'

/**
 * Agent-proposed MCP servers.
 *
 * The agent describes the server through the Sillage tool `install_mcp_server`; nothing is
 * written until the user confirms in the conversation, where the proposal appears as a form
 * they can edit. Secrets are the point of the detour: the agent may only reference
 * `{{secret.NAME}}`, the user types the value in the form, and it lands in the encrypted store
 * without crossing the journal or the model. Non-blocking like a decision: the turn goes on, and
 * the outcome returns to the agent as a message.
 */

/** Agent-facing rejections returned verbatim. */
export class McpInstallRefusal extends Error {}

/** Beyond this, the explanation belongs in the agent's reply, not above a form. */
const MAX_PURPOSE_CHARS = 300

type RequestedEvent = Extract<SillageEvent, { type: 'mcp_install.requested' }>

/** Secret names a transport references, in reading order. */
export function transportSecrets(transport: McpTransport): string[] {
  const values = Object.values(transport.type === 'stdio' ? transport.env : transport.headers)
  return [...new Set(values.flatMap((value) => referencedSecrets(value)))]
}

/**
 * Names are CLI keys shared by both scopes of one conversation, so uniqueness ignores scope.
 * The database constraint catches races; this gives a readable reason first.
 */
export function freeMcpServerName(db: Db, name: string, exceptId?: string): string | null {
  if (isReservedMcpServerName(name)) return `The name “${name}” is reserved by Sillage.`
  const existing = db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, name)).get()
  if (existing && existing.id !== exceptId) return `An MCP server named “${name}” already exists.`
  return null
}

/** The latest proposal of a conversation still awaiting an answer, if any. */
export function pendingMcpInstall(log: EventLog, conversationId: string): RequestedEvent | null {
  const entries = log.latest(conversationId, ['mcp_install.requested', 'mcp_install.resolved'], 20)
  const resolved = new Set<string>()
  for (const entry of entries) {
    const event = entry.event
    if (event.type === 'mcp_install.resolved') resolved.add(event.requestId)
    else if (event.type === 'mcp_install.requested' && !resolved.has(event.requestId)) return event
  }
  return null
}

/** Validates a proposal and posts it to the conversation. Returns the text for the agent and the posted event, for notification. */
export function proposeMcpInstall(
  db: Db,
  log: EventLog,
  conversation: Pick<ConversationRow, 'id' | 'projectId'>,
  payload: Record<string, unknown>,
): { text: string; event: RequestedEvent } {
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!mcpServerNameSchema.safeParse(name).success) {
    throw new McpInstallRefusal('`name` is required: 1 to 64 letters, digits, hyphens or underscores. The CLI prefixes the server tools with it.')
  }
  const taken = freeMcpServerName(db, name)
  if (taken) throw new McpInstallRefusal(`${taken} Pick another name, or use list_mcp_servers to check whether it already does what you need.`)

  const parsedTransport = mcpTransportSchema.safeParse(payload.transport)
  if (!parsedTransport.success) {
    throw new McpInstallRefusal('`transport` must be `{type:"stdio", command, args?, env?}` or `{type:"http"|"sse", url, headers?}`.')
  }
  const transport = parsedTransport.data
  const clear = clearTextSecrets(transport)
  if (clear.length > 0) {
    throw new McpInstallRefusal(
      `Refused: ${clear.join(', ')} look like credentials written in clear. Set them to {{secret.NAME}} instead; the user types the value in the confirmation form and it goes to the encrypted store. Never ask the user to paste a secret in the conversation.`,
    )
  }

  const scopeInput = payload.scope === undefined ? (conversation.projectId ? 'project' : 'global') : payload.scope
  const parsedScope = mcpInstallScopeSchema.safeParse(scopeInput)
  if (!parsedScope.success) throw new McpInstallRefusal('`scope` must be "project" or "global".')
  if (parsedScope.data === 'project' && !conversation.projectId) {
    throw new McpInstallRefusal('This discussion has no project: only the "global" scope is possible here.')
  }

  const purpose = typeof payload.purpose === 'string' ? payload.purpose.trim() : ''
  if (purpose.length > MAX_PURPOSE_CHARS) throw new McpInstallRefusal(`\`purpose\` is limited to ${MAX_PURPOSE_CHARS} characters.`)

  const referenced = transportSecrets(transport)
  const hints = payload.secret_hints
  const secretHints: Record<string, string> = {}
  if (hints && typeof hints === 'object') {
    for (const [key, value] of Object.entries(hints as Record<string, unknown>)) {
      if (referenced.includes(key) && typeof value === 'string' && value.trim()) secretHints[key] = value.trim().slice(0, MAX_PURPOSE_CHARS)
    }
  }

  const pending = pendingMcpInstall(log, conversation.id)
  if (pending) {
    throw new McpInstallRefusal(`A proposal (“${pending.name}”) is already waiting for the user: only one at a time. Wait for their answer, which arrives as a message.`)
  }

  const event: RequestedEvent = {
    type: 'mcp_install.requested',
    requestId: randomUUID(),
    name,
    transport,
    purpose: purpose || null,
    scope: parsedScope.data,
    secretHints,
  }
  log.append(conversation.id, event)

  const text = [
    `The proposal for “${name}” is shown to the user in this conversation, with every parameter editable${referenced.length > 0 ? ` and a field for ${referenced.join(', ')}` : ''}.`,
    'Do not wait for it: end your turn or continue independent work. You will receive a message when the user installs or declines it, and the server tools become available in this session once installed.',
    'Do not propose it again meanwhile.',
  ].join(' ')
  return { text, event }
}

export interface McpInstallDeps {
  db: Db
  log: EventLog
  secrets: SecretStore
  sessions: Pick<SessionManager, 'sendMessage' | 'reloadConfig'>
}

/**
 * Applies the user's answer: stores typed secrets, creates the registry entry, enables it for the
 * requesting conversation, then tells the agent. Returns the created server for the UI, or null
 * when declined. Throws `McpInstallRefusal` for the user with the reason to display.
 */
export async function answerMcpInstall(
  deps: McpInstallDeps,
  conversation: Pick<ConversationRow, 'id' | 'projectId'>,
  request: RequestedEvent,
  body: AnswerMcpInstallBody,
  decidedBy: string,
): Promise<ReturnType<typeof rowToMcpServer> | null> {
  const { db, log, secrets, sessions } = deps

  if (body.decision === 'declined') {
    log.append(conversation.id, {
      type: 'mcp_install.resolved',
      requestId: request.requestId,
      decision: 'declined',
      serverId: null,
      name: null,
      scope: null,
      decidedBy,
    })
    await notify(sessions, conversation.id, [
      '[Sillage — MCP server proposal declined]',
      '',
      `The user declined installing “${request.name}”. Continue without it; do not propose it again unless asked.`,
    ])
    return null
  }

  const taken = freeMcpServerName(db, body.name)
  if (taken) throw new McpInstallRefusal(taken)
  if (body.scope === 'project' && !conversation.projectId) {
    throw new McpInstallRefusal('This discussion has no project: choose the global scope.')
  }
  // Every referenced secret must resolve after this call, otherwise the server would start
  // excluded with a “missing secret” failure the user did not see coming.
  const missing = transportSecrets(body.transport).filter((name) => secrets.resolve(name) === undefined && !body.secrets[name])
  if (missing.length > 0) throw new McpInstallRefusal(`Missing value for ${missing.join(', ')}.`)

  for (const [name, value] of Object.entries(body.secrets)) secrets.put(name, value)

  const now = Date.now()
  const row = {
    id: randomUUID(),
    name: body.name,
    enabled: true,
    transport: JSON.stringify(body.transport),
    projectId: body.scope === 'project' ? conversation.projectId : null,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(mcpServers).values(row).run()

  // Project servers reach their conversations by scope; a global one must be selected here so the
  // requesting session gets what it asked for, like a user ticking it in the composer.
  if (body.scope === 'global') {
    const current = db.select({ config: conversations.config }).from(conversations).where(eq(conversations.id, conversation.id)).get()
    if (current) {
      const config = parseAgentConfig(current.config)
      if (!config.mcpServers.includes(row.id)) {
        db.update(conversations)
          .set({ config: JSON.stringify({ ...config, mcpServers: [...config.mcpServers, row.id] }) })
          .where(eq(conversations.id, conversation.id))
          .run()
      }
    }
  }

  log.append(conversation.id, {
    type: 'mcp_install.resolved',
    requestId: request.requestId,
    decision: 'installed',
    serverId: row.id,
    name: body.name,
    scope: body.scope,
    decidedBy,
  })

  // Live where the CLI allows it (Claude), otherwise after the turn, like any settings change.
  await sessions.reloadConfig(conversation.id).catch(() => undefined)
  await notify(sessions, conversation.id, [
    '[Sillage — MCP server installed]',
    '',
    `“${body.name}” is installed ${describeScope(body.scope)} and enabled in this session${body.name === request.name ? '' : ` (renamed from “${request.name}”)`}.`,
    `Its tools appear as mcp__${body.name}__<tool>; if they are not listed yet, they will be after the session restarts at the end of the turn.`,
  ])

  return rowToMcpServer(row)
}

function describeScope(scope: McpInstallScope): string {
  return scope === 'project' ? 'for this project' : 'for the whole instance'
}

async function notify(sessions: McpInstallDeps['sessions'], conversationId: string, lines: string[]): Promise<void> {
  try {
    await sessions.sendMessage(conversationId, randomUUID(), lines.join('\n'))
  } catch (err) {
    // The registry write already succeeded; a message lost to a stopped session is not a failure.
    process.stderr.write(`[mcp-install ${conversationId}] agent not notified: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
