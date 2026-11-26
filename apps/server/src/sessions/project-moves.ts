import type { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { eq, isNull } from 'drizzle-orm'
import { conversationProjectMoves, type Db } from '@sillage/db'
import type { EventLog } from '../events/event-log.js'
import { HttpError } from '../http/errors.js'
import { commitProjectMove, pendingProjectMove, prepareProjectMove, requestProjectMove } from '../conversations/project-transfer.js'

/** What a move needs from the session manager, which owns runners and queues. */
export interface ProjectMoveHooks {
  /** Idle or cold, with no detached work: stopping the CLI now loses nothing. */
  canMove(conversationId: string): boolean
  stopRunner(conversationId: string, options: { keepQueue: boolean }): Promise<void>
  flushQueue(conversationId: string): Promise<void>
  broadcastStatus(conversationId: string, status: 'idle', warm: boolean): void
}

/** Moves of a session to another project: requested at any time, applied once the conversation has nothing running. */
export class ProjectMoves {
  private readonly locks = new Set<string>()

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly statusBus: EventEmitter,
    private readonly hooks: ProjectMoveHooks,
  ) {}

  /** The conversation is changing project; its runner is being stopped. */
  isMoving(conversationId: string): boolean {
    return this.locks.has(conversationId)
  }

  /** A move has been requested and not applied yet. */
  isPending(conversationId: string): boolean {
    return Boolean(pendingProjectMove(this.db, conversationId))
  }

  /** Agents request their own move during a turn; acknowledge it before stopping their MCP process. */
  async moveToProject(conversationId: string, userId: string, target: string) {
    const result = await requestProjectMove(this.db, conversationId, userId, target)
    await this.apply(conversationId)
    const stored = this.db.select().from(conversationProjectMoves).where(eq(conversationProjectMoves.id, result.move.id)).get()
    if (stored?.error) throw new HttpError(409, 'project_move_failed', stored.error)
    if (stored?.completedAt === null) this.log.append(conversationId, {
      type: 'agent.notice', id: result.move.id, code: 'project_move_pending', level: 'info',
      message: `Move to ${result.project.name} scheduled after the turn and background work finish.`,
      details: { project: result.project.name },
    })
    this.statusBus.emit('lists')
    return { projectId: result.project.id, projectName: result.project.name, pending: Boolean(pendingProjectMove(this.db, conversationId)) }
  }

  /** Also swept by the daemon after recovery and when detached work finishes. */
  async applyPending(): Promise<void> {
    const pending = this.db.select({ conversationId: conversationProjectMoves.conversationId }).from(conversationProjectMoves)
      .where(isNull(conversationProjectMoves.completedAt)).all()
    await Promise.all(pending.map(move => this.apply(move.conversationId)))
  }

  async apply(conversationId: string): Promise<void> {
    if (!this.hooks.canMove(conversationId)) return
    const pending = pendingProjectMove(this.db, conversationId)
    if (!pending) return
    this.locks.add(conversationId)
    try {
      const prepared = prepareProjectMove(this.db, this.log, conversationId)
      if (!prepared) return
      if (!(await stat(prepared.project.workspacePath).catch(() => null))?.isDirectory()) throw new Error('The destination project directory is missing.')
      await this.hooks.stopRunner(conversationId, { keepQueue: true })
      // Recheck access after stopping: project visibility may have changed meanwhile.
      const current = prepareProjectMove(this.db, this.log, conversationId)
      if (!current) return
      commitProjectMove(this.db, current)
      this.statusBus.emit('workspace', { conversationId })
      // Revoke old viewers' subscriptions before publishing events in the destination project.
      this.statusBus.emit('lists')
      this.log.append(conversationId, {
        type: 'agent.notice', id: current.move.id, code: 'project_moved', level: 'info',
        message: `Session moved to ${current.project.name}. History is preserved; the next message uses the destination workspace and instructions.`,
        details: { project: current.project.name, previousDirectory: current.move.fromCwd, directory: current.project.workspacePath },
      })
      this.hooks.broadcastStatus(conversationId, 'idle', false)
    } catch (error) {
      this.db.update(conversationProjectMoves).set({ completedAt: Date.now(), error: String(error) }).where(eq(conversationProjectMoves.id, pending.id)).run()
      this.log.append(conversationId, { type: 'agent.notice', code: 'project_move_failed', level: 'warning', message: `The session could not be moved: ${error instanceof Error ? error.message : String(error)}`, details: String(error) })
    } finally {
      this.locks.delete(conversationId)
    }
    await this.hooks.flushQueue(conversationId)
  }
}
