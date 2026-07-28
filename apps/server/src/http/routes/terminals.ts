import type { FastifyInstance } from 'fastify'
import { renameTerminalBodySchema, type TerminalDto } from '@sillage/protocol'
import type { SessionManager } from '../../sessions/session-manager.js'
import { TerminalError, type TerminalManager } from '../../terminals/terminal-manager.js'
import type { AppContext } from '../context.js'
import { HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'
import { canReadConversation } from './conversations.js'

/**
 * Cycle de vie des terminaux. La sortie, elle, passe par la socket dédiée.
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
  const guard = (conversationId: string, userId: string): void => {
    if (!canReadConversation(ctx, conversationId, userId)) {
      throw new HttpError(404, 'conversation_not_found', 'Conversation not found.')
    }
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

  app.get('/api/conversations/:id/terminals', async (request): Promise<TerminalDto[]> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    guard(id, user.id)
    return terminals.list(id)
  })

  app.post('/api/conversations/:id/terminals', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    guard(id, user.id)

    // Le répertoire de travail vient de la conversation, worktree compris : c'est là
    // que l'agent travaille, et un shell ouvert ailleurs serait trompeur.
    const terminal = wrap(() => terminals.open(id, sessions.workingDirectory(id)))
    return reply.status(201).send(terminal)
  })

  app.patch('/api/conversations/:id/terminals/:terminalId', async (request) => {
    const user = requireUser(request)
    const { id, terminalId } = request.params as { id: string; terminalId: string }
    guard(id, user.id)

    const { title } = renameTerminalBodySchema.parse(request.body)
    return wrap(() => terminals.rename(id, terminalId, title))
  })

  app.delete('/api/conversations/:id/terminals/:terminalId', async (request, reply) => {
    const user = requireUser(request)
    const { id, terminalId } = request.params as { id: string; terminalId: string }
    guard(id, user.id)

    wrap(() => terminals.closeIn(id, terminalId))
    return reply.status(204).send()
  })
}
