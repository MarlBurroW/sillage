import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { conversations, projects } from '@sillage/db'
import { readProjectDefaults, type AntigravityConfig } from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import { listAntigravitySessions } from '../../agents/antigravity/sessions.js'
import { createConversation } from '../../conversations/create.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import { readUserSettings } from '../../settings/user-settings.js'
import { badRequest, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import type { AppContext } from '../context.js'
import { conversationToDto } from './conversations.js'

/** Session ownership follows the selected account; import always checks the native cwd. */
export function registerAntigravitySessionRoutes(app: FastifyInstance, ctx: AppContext, sessions: SessionManager, registry: AgentRegistry): void {
  const importing = new Set<string>()
  const projectFor = (id: string, userId: string) => {
    const row = ctx.db.select().from(projects).where(eq(projects.id, id)).get()
    if (!row || (row.ownerId !== userId && row.visibility !== 'shared')) throw notFound('project_not_found', 'Project not found.')
    return row
  }
  const linked = () => new Set(ctx.db.select({ id: conversations.agentSessionId }).from(conversations).where(eq(conversations.agent, 'antigravity')).all().map((row) => row.id))
  const query = z.object({ account: z.string().uuid().optional() })
  app.get('/api/projects/:id/antigravity-sessions', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = projectFor(id, user.id)
    const { account } = query.parse(request.query)
    const home = sessions.antigravityHome(user.id, account ?? null)
    const found = await listAntigravitySessions(await registry.adapter('antigravity').cli.executable(), project.workspacePath, home)
    const attached = linked()
    return { sessions: found.sessions.filter((session) => !attached.has(session.sessionId)) }
  })
  app.post('/api/projects/:id/antigravity-sessions/:sessionId/import', async (request, reply) => {
    const user = requireUser(request)
    const { id, sessionId: rawId } = request.params as { id: string; sessionId: string }
    const sessionId = z.string().uuid().parse(rawId)
    const project = projectFor(id, user.id)
    const { account } = query.parse(request.query)
    const home = sessions.antigravityHome(user.id, account ?? null)
    if (linked().has(sessionId) || importing.has(sessionId)) throw badRequest('session_already_imported', 'This session already has a conversation.')
    importing.add(sessionId)
    try {
      const found = await listAntigravitySessions(await registry.adapter('antigravity').cli.executable(), project.workspacePath, home)
      const info = found.sessions.find((entry) => entry.sessionId === sessionId)
      if (!info) throw notFound('transcript_not_found', 'No transcript found for this session in the project folder.')
      const defaults = readProjectDefaults(project.defaultConfig).antigravity ?? readUserSettings(ctx.db, user.id).agentDefaults.antigravity
      const config: AntigravityConfig = { ...defaults, account: account ?? null }
      const row = await createConversation(ctx.db, sessions, { projectId: id, userId: user.id, agent: 'antigravity', config, worktreeId: null, cardId: null, origin: null, title: info.title })
      ctx.db.update(conversations).set({ agentSessionId: sessionId, titleSetByUser: false }).where(eq(conversations.id, row.id)).run()
      try {
        await sessions.importNativeHistory({ ...row, agentSessionId: sessionId })
        const loaded = ctx.db.select().from(conversations).where(eq(conversations.id, row.id)).get()!
        return reply.status(201).send(conversationToDto(loaded, user.id, 0, null, false))
      } catch (error) { ctx.db.delete(conversations).where(eq(conversations.id, row.id)).run(); throw error }
    } finally { importing.delete(sessionId) }
  })
}
