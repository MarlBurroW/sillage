import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations, worktrees } from '@sillage/db'
import { openTerminalBodySchema, renameTerminalBodySchema, type TerminalDto } from '@sillage/protocol'
import type { SessionManager } from '../../sessions/session-manager.js'
import { TerminalError, type TerminalManager } from '../../terminals/terminal-manager.js'
import type { AppContext } from '../context.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'
import { visibleProject } from './projects.js'

/** Terminal lifecycle; output uses a dedicated socket. Project-scoped rather than conversation-scoped: a pty is a process in a directory, and conversations merely supply the default directory when opening one. One list per project ensures archived conversations hide nothing. Any project viewer may open terminals, like the rest of the panel. This deliberate, documented choice allows arbitrary commands as the daemon's Unix user across the whole machine, beyond the workspace. */
export function registerTerminalRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  sessions: SessionManager,
  terminals: TerminalManager,
): void {
  const guard = (projectId: string, userId: string) => {
    const project = visibleProject(ctx, projectId, userId)
    if (!project) throw new HttpError(404, 'project_not_found', 'Project not found.')
    return project
  }

  /** Translates manager rejections to HTTP responses without rewriting messages. */
  const wrap = <T>(action: () => T): T => {
    try {
      return action()
    } catch (err) {
      if (err instanceof TerminalError) {
        throw new HttpError(err.code === 'terminal_not_found' ? 404 : 409, err.code, err.message)
      }
      throw err
    }
  }

  app.get('/api/projects/:id/terminals', async (request): Promise<TerminalDto[]> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    guard(id, user.id)
    return terminals.list(id)
  })

  app.post('/api/projects/:id/terminals', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = guard(id, user.id)
    const body = openTerminalBodySchema.parse(request.body ?? {})

    // From a session, open the shell where its agent works, including worktrees;
    // from the project view, use the workspace.
    let cwd = project.workspacePath
    if (body.conversationId) {
      const row = ctx.db
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, body.conversationId))
        .get()
      if (!row || row.projectId !== id) {
        throw new HttpError(404, 'conversation_not_found', 'Conversation not found.')
      }
      cwd = sessions.workingDirectory(body.conversationId)
    } else if (body.cwd && body.cwd !== project.workspacePath) {
      // Restarting interrupted shells requires the requested directory to still exist
      // inside the project; unrestricted paths would open shells anywhere on its behalf.
      const worktree = ctx.db
        .select({ id: worktrees.id })
        .from(worktrees)
        .where(
          and(eq(worktrees.projectId, id), eq(worktrees.path, body.cwd), isNull(worktrees.removedAt)),
        )
        .get()
      if (!worktree) {
        throw new HttpError(404, 'terminal_cwd_gone', 'This directory is no longer part of the project.')
      }
      cwd = body.cwd
    }

    const terminal = wrap(() => terminals.open(id, cwd))
    return reply.status(201).send(terminal)
  })

  app.patch('/api/projects/:id/terminals/:terminalId', async (request) => {
    const user = requireUser(request)
    const { id, terminalId } = request.params as { id: string; terminalId: string }
    guard(id, user.id)

    const { title } = renameTerminalBodySchema.parse(request.body)
    return wrap(() => terminals.rename(id, terminalId, title))
  })

  app.delete('/api/projects/:id/terminals/:terminalId', async (request, reply) => {
    const user = requireUser(request)
    const { id, terminalId } = request.params as { id: string; terminalId: string }
    guard(id, user.id)

    wrap(() => terminals.closeIn(id, terminalId))
    return reply.status(204).send()
  })
}
