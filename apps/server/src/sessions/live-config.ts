import { eq } from 'drizzle-orm'
import { conversations, mcpServers, type ConversationRow, type Db } from '@sillage/db'
import { parseAgentConfig, type ConversationStatus } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import { HttpError } from '../http/errors.js'
import type { RunnerPool } from './runner-pool.js'

/** What live reconfiguration needs from the session manager. */
export interface LiveConfigHooks {
  loadConversation(conversationId: string): ConversationRow
  /** Whether a turn, or a hand-over to the CLI, has control. */
  isBusy(conversationId: string): boolean
  setStatus(conversationId: string, status: ConversationStatus): void
}

/** Settings, skills and MCP servers changed while sessions run: applied live when the CLI can, otherwise by a restart that waits for the turn to end. */
export class LiveConfig {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly pool: RunnerPool,
    private readonly hooks: LiveConfigHooks,
  ) {}

  /** Applies reread database configuration. SDK live model, effort and permission updates preserve context; stop and resume only on CLI rejection. Known exception: Claude `bypassPermissions` changes require startup in both directions. Entering explicitly fails ('the session was not launched with --dangerously-skip-permissions'); leaving apparently succeeds but is ineffective, so runners reject explicitly. Delay restart until turn completion to avoid losing ongoing work for future settings. */
  async reload(conversationId: string): Promise<void> {
    const managed = this.pool.runners.get(conversationId)
    if (!managed) return

    const conversation = this.hooks.loadConversation(conversationId)
    const config = parseAgentConfig(conversation.config)

    let applied = false
    let reason: string | null = null
    try {
      applied = await managed.runner.applyConfig(config)
      if (!applied) reason = 'the CLI cannot apply this change live'
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (applied) {
      // Returning settings to live-applicable values cancels promised restarts:
      // otherwise sessions would restart needlessly after turns.
      managed.pendingRestart = null
      return
    }

    if (this.hooks.isBusy(conversationId)) {
      managed.pendingRestart = reason
      this.log.append(conversationId, {
        type: 'error',
        code: 'config_restart_deferred',
        message: 'This setting requires restarting the session: it will take effect at the end of the turn.',
        recoverable: true,
      })
      return
    }

    await this.restart(conversationId, reason)
  }

  /**
   * Retries one failed MCP server in an open session. Allowed mid-turn, unlike compaction: the
   * agent itself often starts the dependency and needs the tools before the turn ends. A cold
   * conversation has nothing to reconnect, its next start connects everything anew.
   */
  async reconnectMcpServer(conversationId: string, name: string): Promise<boolean> {
    const managed = this.pool.runners.get(conversationId)
    if (!managed) {
      throw new HttpError(409, 'conversation_cold', 'The session is not running: its next message reconnects every server.')
    }
    try {
      return await managed.runner.reconnectMcpServer(name)
    } catch (err) {
      if (err instanceof HttpError) throw err
      // The CLI's own words (ECONNREFUSED, 401…) tell the user what to fix; a generic 500 would hide them.
      throw new HttpError(502, 'mcp_reconnect_failed', err instanceof Error ? err.message : String(err))
    }
  }

  /** Reloads skills in affected open sessions: all for global scope (`null`), project sessions otherwise. Fire and forget without failure: writes already succeeded and unsuccessful reloads apply on next resume. */
  reloadSkillLibrary(projectId: string | null): void {
    for (const [conversationId, managed] of this.pool.runners) {
      if (projectId !== null) {
        const row = this.db
          .select({ projectId: conversations.projectId })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get()
        if (row?.projectId !== projectId) continue
      }
      managed.runner.reloadSkillLibrary().catch((err: unknown) => {
        process.stderr.write(
          `[skills ${conversationId}] reload failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
    }
  }

  /** Reapplies configuration in open sessions using an edited or deleted registry server: those selecting it, and every open session of the project it is scoped to, since project servers apply without selection. Runners compare resolved servers, so an unchanged ID list with a new URL or token still reconnects; restarts wait for turn ends like any setting change. `formerProjectId` covers the sessions a deletion or a move takes the server from, which the row no longer names. Fire and forget: the write already succeeded. */
  reloadMcpServer(serverId: string, formerProjectId: string | null = null): void {
    const scopedProject = this.db.select({ projectId: mcpServers.projectId }).from(mcpServers).where(eq(mcpServers.id, serverId)).get()?.projectId ?? null
    for (const conversationId of this.pool.runners.keys()) {
      const row = this.db
        .select({ config: conversations.config, projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()
      if (!row) continue
      const concerned = parseAgentConfig(row.config).mcpServers.includes(serverId)
        || (row.projectId !== null && (row.projectId === scopedProject || row.projectId === formerProjectId))
      if (!concerned) continue
      this.reload(conversationId).catch((err: unknown) => {
        process.stderr.write(
          `[mcp ${conversationId}] reconfiguration failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
    }
  }

  /** Stops runners to reload current configuration. Explain fallback in conversations because reloading context has real cost users should understand. */
  async restart(conversationId: string, reason: string | null): Promise<void> {
    // Queues survive: the next send finds them, and `deliver` starts fresh runners
    // with current configuration. Expiring messages would lose them
    // for restarts that otherwise lose nothing.
    await this.pool.stop(conversationId, { keepQueue: true })
    this.log.append(conversationId, {
      type: 'error',
      code: 'config_applied_by_restart',
      message: `Settings applied by restarting the session (${reason ?? 'no reason given'}).`,
      recoverable: true,
    })
    this.hooks.setStatus(conversationId, 'idle')
  }
}
