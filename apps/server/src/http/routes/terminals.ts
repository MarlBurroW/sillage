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

/**
 * Cycle de vie des terminaux. La sortie, elle, passe par la socket dédiée.
 *
 * Scopés au projet, pas à la conversation : un pty est un process qui vit dans un
 * répertoire, et la session ne fait que fournir ce répertoire par défaut à
 * l'ouverture. La liste est unique par projet, donc rien ne se cache derrière une
 * conversation archivée.
 *
 * Tout compte qui voit le projet peut en ouvrir un, comme le reste du panneau. C'est
 * un choix assumé et documenté : un terminal exécute des commandes arbitraires sous le
 * compte Unix du daemon, donc sur toute la machine et pas seulement sur le workspace.
 */
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

  /** Traduit le refus du gestionnaire en réponse HTTP, sans réécrire son message. */
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

    // Depuis une session, le shell s'ouvre là où l'agent travaille, worktree compris ;
    // depuis la vue projet, dans le workspace.
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
      // Relance d'un shell interrompu : le répertoire demandé doit encore exister dans
      // le projet, un chemin libre ouvrirait un shell n'importe où au nom du projet.
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
