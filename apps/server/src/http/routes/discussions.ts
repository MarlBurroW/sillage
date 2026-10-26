import { rm } from 'node:fs/promises'
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, personalWorkspaces, writeTransaction } from '@sillage/db'
import { memoryFileSchema, writeMemoryFileBodySchema, type PersonalWorkspaceDto } from '@sillage/protocol'
import { personalWorkspace } from '../../conversations/personal-workspaces.js'
import { personalMemoryDir, readPersonalMemory, writePersonalMemory } from '../../memory/personal.js'
import type { AppContext } from '../context.js'
import { conflict } from '../errors.js'
import { requireUser } from '../require-user.js'

export function registerDiscussionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/me/memory', async request => {
    const user = requireUser(request)
    return readPersonalMemory(ctx.db, personalMemoryDir(ctx.config.paths.memory, user.id), user.id)
  })
  app.put('/api/me/memory/:file', async (request, reply) => {
    const user = requireUser(request)
    const file = memoryFileSchema.parse((request.params as { file: string }).file)
    const { content } = writeMemoryFileBodySchema.parse(request.body)
    await writePersonalMemory(ctx.db, personalMemoryDir(ctx.config.paths.memory, user.id), user.id, file, content)
    return reply.status(204).send()
  })
  app.delete('/api/me/memory/:file', async (request, reply) => {
    const user = requireUser(request)
    const file = memoryFileSchema.parse((request.params as { file: string }).file)
    await writePersonalMemory(ctx.db, personalMemoryDir(ctx.config.paths.memory, user.id), user.id, file, null)
    return reply.status(204).send()
  })
  app.get('/api/discussions/workspaces', async (request): Promise<PersonalWorkspaceDto[]> => {
    const user = requireUser(request)
    const workspaces = ctx.db.select().from(personalWorkspaces).where(eq(personalWorkspaces.userId, user.id))
      .orderBy(desc(personalWorkspaces.createdAt)).all()
    const sessions = ctx.db.select({ id: conversations.id, title: conversations.title, workspaceId: conversations.workspaceId })
      .from(conversations).where(eq(conversations.userId, user.id)).all()
    return workspaces.map(row => ({ ...row, conversations: sessions.filter(session => session.workspaceId === row.id).map(({ id, title }) => ({ id, title })) }))
  })
  app.delete('/api/personal-workspaces/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const workspace = personalWorkspace(ctx.db, id, user.id)
    // Remove the FK target synchronously so a concurrent fork cannot reuse a folder being removed.
    writeTransaction(ctx.db, tx => {
      if (tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, id)).get()) {
        throw conflict('workspace_in_use', 'This directory is still used by a discussion.')
      }
      tx.delete(personalWorkspaces).where(and(eq(personalWorkspaces.id, id), eq(personalWorkspaces.userId, user.id))).run()
    })
    try { await rm(workspace.path, { recursive: true, force: true }) }
    catch (error) {
      ctx.db.insert(personalWorkspaces).values(workspace).run()
      throw error
    }
    return reply.status(204).send()
  })
}
