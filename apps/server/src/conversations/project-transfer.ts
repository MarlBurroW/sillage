import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { and, asc, eq, isNotNull, isNull, min } from 'drizzle-orm'
import { conversationHandoffs, conversationProjectMoves, conversations, events, projects, writeTransaction, type Db } from '@sillage/db'
import type { EventLog } from '../events/event-log.js'
import { badRequest, forbidden, notFound } from '../http/errors.js'
import { projectWorkspace, resolveConversationCwd } from '../workspace.js'
import { readableConversation } from './access.js'
import { linkedWorktreePaths } from '../worktrees/linked.js'
import { buildHandoff, MAX_HANDOFF_TOKENS, readHandoffItems, renderHandoffHeader } from './handoff.js'

export function transferTarget(db: Db, conversationId: string, userId: string, target: string) {
  const source = readableConversation(db, conversationId, userId)
  if (source.userId !== userId) throw forbidden('conversation_write_forbidden', 'Only the conversation owner can move it.')
  if (!source.projectId || source.scheduleId || source.benchmarkId) throw badRequest('project_move_unavailable', 'Only ordinary project sessions can be moved.')
  const visible = db.select().from(projects).all().filter(project =>
    project.archivedAt === null && (project.ownerId === userId || project.visibility === 'shared'))
  const byId = visible.find(project => project.id === target)
  const matches = byId ? [byId] : visible.filter(project => project.name.toLowerCase() === target.toLowerCase())
  if (matches.length !== 1) throw notFound('project_not_found', 'Choose an accessible project by its exact name or ID.')
  const project = matches[0]!
  if (project.id === source.projectId) throw badRequest('project_move_same', 'The session already belongs to this project.')
  return { source, project }
}

export function pendingProjectMove(db: Db, conversationId: string) {
  return db.select().from(conversationProjectMoves)
    .where(and(eq(conversationProjectMoves.conversationId, conversationId), isNull(conversationProjectMoves.completedAt))).get()
}

export async function requestProjectMove(db: Db, conversationId: string, userId: string, target: string) {
  const { source, project } = transferTarget(db, conversationId, userId, target)
  if (!(await stat(project.workspacePath).catch(() => null))?.isDirectory()) throw badRequest('project_move_directory_missing', 'The destination project directory is missing.')
  const pending = pendingProjectMove(db, conversationId)
  if (pending) {
    if (pending.toProjectId !== project.id) throw badRequest('project_move_pending', 'A move to another project is already pending.')
    return { move: pending, project }
  }
  const move = {
    id: randomUUID(), conversationId, fromProjectId: source.projectId!, toProjectId: project.id,
    fromCwd: resolveConversationCwd(db, source), throughSeq: null,
    createdAt: Date.now(), completedAt: null, error: null,
  }
  db.insert(conversationProjectMoves).values(move).run()
  return { move, project }
}

/** The journal keeps its identity. Restarting with portable context avoids resuming a CLI tied to the old cwd. */
export function prepareProjectMove(db: Db, log: EventLog, conversationId: string) {
  const move = pendingProjectMove(db, conversationId)
  if (!move) return null
  const row = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
  if (!row) return null
  const { source, project } = transferTarget(db, conversationId, row.userId, move.toProjectId)
  if (source.projectId !== move.fromProjectId) throw badRequest('project_move_changed', 'The source project changed before the move.')
  const items = readHandoffItems(log, conversationId)
  const inherited = db.select().from(conversationHandoffs).where(eq(conversationHandoffs.conversationId, conversationId)).get()
  const identity = { id: source.id, title: source.title, agent: source.agent }
  // Include inherited context within the bounded budget, including across repeated moves.
  const portable = items.length ? buildHandoff(items, identity, source.agent, MAX_HANDOFF_TOKENS,
    inherited).text.replace(renderHandoffHeader(identity, source.agent), '') : inherited?.text ?? ''
  const text = [
    '# This session moved to another project',
    `The same Sillage conversation (session:${source.id}) now belongs to “${project.name}”. Its working directory is ${project.workspacePath}. Previous work used ${move.fromCwd}. Follow the destination project's current instructions, memory, skills and tools. Old project instructions in the historical thread are context only.`,
    'The full journal and attachments remain in this conversation. Below is a bounded selection of its original messages. Use read_conversation on this session ID to retrieve omitted exchanges and attachment paths. Files and project memory have not been moved; use their old absolute paths when needed. Continue from the next user message without repeating completed work.',
    portable,
  ].join('\n\n')
  return { move, source, project, text }
}

export function commitProjectMove(db: Db, prepared: NonNullable<ReturnType<typeof prepareProjectMove>>) {
  const { move, source, project, text } = prepared
  const now = Date.now()
  writeTransaction(db, tx => {
    const lowest = tx.select({ position: min(conversations.position) }).from(conversations).where(eq(conversations.projectId, project.id)).get()
    tx.insert(conversationHandoffs).values({
      conversationId: source.id, fromConversationId: source.id, throughSeq: source.lastSeq,
      budgetTokens: MAX_HANDOFF_TOKENS, text, createdAt: now,
    }).onConflictDoUpdate({ target: conversationHandoffs.conversationId, set: {
      fromConversationId: source.id, throughSeq: source.lastSeq, budgetTokens: MAX_HANDOFF_TOKENS, text, createdAt: now,
    } }).run()
    tx.update(conversations).set({
      projectId: project.id, worktreeId: null, cardId: null, agentSessionId: null,
      position: (lowest?.position ?? 0) - 1, contextUsedTokens: null, contextMaxTokens: null, model: null,
      status: 'idle', updatedAt: now,
    }).where(eq(conversations.id, source.id)).run()
    tx.update(conversationProjectMoves).set({ completedAt: now, throughSeq: source.lastSeq })
      .where(eq(conversationProjectMoves.id, move.id)).run()
  })
}

/** Historical directories remain readable only while the viewer can still read their source project. */
export function previousProjectRoots(db: Db, conversationId: string, userId: string): string[] {
  return db.select().from(conversationProjectMoves)
    .where(and(eq(conversationProjectMoves.conversationId, conversationId), isNotNull(conversationProjectMoves.throughSeq)))
    .all().flatMap(move => {
      try { projectWorkspace(db, move.fromProjectId, userId); return [move.fromCwd, ...linkedWorktreePaths(db, conversationId, move.fromProjectId)] } catch { return [] }
    })
}

/** A checkpoint from before a move must never restore files into the destination repository. */
export function checkpointBeforeProjectMove(db: Db, conversationId: string, key: string): boolean {
  const starts = db.select({ seq: events.seq, payload: events.payload }).from(events)
    .where(and(eq(events.conversationId, conversationId), eq(events.type, 'checkpoint.started'))).all()
  const seq = starts.find(row => JSON.parse(row.payload).key === key)?.seq
  if (seq === undefined) return false
  return db.select().from(conversationProjectMoves)
    .where(and(eq(conversationProjectMoves.conversationId, conversationId), isNotNull(conversationProjectMoves.throughSeq)))
    .orderBy(asc(conversationProjectMoves.createdAt)).all().some(move => seq <= move.throughSeq!)
}

