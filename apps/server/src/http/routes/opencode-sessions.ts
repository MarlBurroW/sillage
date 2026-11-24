import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { conversations, projects } from '@sillage/db'
import { readProjectDefaults, type OpencodeConfig } from '@sillage/protocol'
import { OpencodeAdapter } from '../../agents/opencode/adapter.js'
import type { AgentRegistry } from '../../agents/registry.js'
import { createConversation } from '../../conversations/create.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import { readUserSettings } from '../../settings/user-settings.js'
import { badRequest, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import type { AppContext } from '../context.js'
import { conversationToDto } from './conversations.js'

/**
 * OpenCode sessions begun outside Sillage in a project folder, and their adoption. Same contract as
 * the Claude and Antigravity routes, which the draft page reads by CLI name. OpenCode 2 only: it
 * keeps a structured history the runner replays (see v2/history.ts).
 */
export function registerOpencodeSessionRoutes(app: FastifyInstance, ctx: AppContext, sessions: SessionManager, registry: AgentRegistry): void {
  const importing = new Set<string>()
  const adapter = () => registry.adapter('opencode') as OpencodeAdapter
  const projectFor = (id: string, userId: string) => {
    const row = ctx.db.select().from(projects).where(eq(projects.id, id)).get()
    if (!row || (row.ownerId !== userId && row.visibility !== 'shared')) throw notFound('project_not_found', 'Project not found.')
    return row
  }
  // Sessions already behind a conversation, Sillage's own included.
  const linked = () => new Set(ctx.db.select({ id: conversations.agentSessionId }).from(conversations).where(eq(conversations.agent, 'opencode')).all().map((row) => row.id))

  app.get('/api/projects/:id/opencode-sessions', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = projectFor(id, user.id)
    const attached = linked()
    const found = await adapter().nativeSessions(project.workspacePath)
    return { sessions: found.filter((session) => !attached.has(session.sessionId)) }
  })

  app.post('/api/projects/:id/opencode-sessions/:sessionId/import', async (request, reply) => {
    const user = requireUser(request)
    const { id, sessionId: rawId } = request.params as { id: string; sessionId: string }
    const sessionId = z.string().regex(/^ses_[A-Za-z0-9]+$/).parse(rawId)
    const project = projectFor(id, user.id)
    if (linked().has(sessionId) || importing.has(sessionId)) throw badRequest('session_already_imported', 'This session already has a conversation.')
    importing.add(sessionId)
    try {
      const info = (await adapter().nativeSessions(project.workspacePath)).find((entry) => entry.sessionId === sessionId)
      if (!info) throw notFound('transcript_not_found', 'No transcript found for this session in the project folder.')
      const config: OpencodeConfig = readProjectDefaults(project.defaultConfig).opencode ?? readUserSettings(ctx.db, user.id).agentDefaults.opencode
      const row = await createConversation(ctx.db, sessions, { projectId: id, userId: user.id, agent: 'opencode', config, worktreeId: null, cardId: null, origin: null, title: info.title })
      ctx.db.update(conversations).set({ agentSessionId: sessionId, titleSetByUser: false }).where(eq(conversations.id, row.id)).run()
      try {
        await sessions.importNativeHistory({ ...row, agentSessionId: sessionId })
        const loaded = ctx.db.select().from(conversations).where(eq(conversations.id, row.id)).get()!
        return reply.status(201).send(conversationToDto(loaded, user.id, 0, null, false))
      } catch (error) {
        ctx.db.delete(conversations).where(eq(conversations.id, row.id)).run()
        throw error
      }
    } finally {
      importing.delete(sessionId)
    }
  })
}
