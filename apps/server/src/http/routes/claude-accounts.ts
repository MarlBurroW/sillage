import type { FastifyInstance } from 'fastify'
import {
  createClaudeAccountBodySchema,
  updateClaudeAccountBodySchema,
  type ClaudeAccount,
  type ClaudeAccountListDto,
} from '@sillage/protocol'
import type { ClaudeAccountStore } from '../../claude-accounts/store.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Comptes Claude supplémentaires de l'utilisateur courant.
 *
 * Par compte Sillage et non par instance, comme les credentials git : un jeton de
 * `setup-token` engage l'abonnement de quelqu'un. Chacun ne voit et ne modifie que les
 * siens, administrateur compris.
 *
 * Aucune route ne rend un jeton. Il se remplace entier quand il expire, au bout d'un
 * an, ce qui est le geste courant.
 */
export function registerClaudeAccountRoutes(app: FastifyInstance, accounts: ClaudeAccountStore): void {
  const taken = () =>
    new HttpError(409, 'claude_account_label_taken', 'Another account already has this name.')

  app.get('/api/claude-accounts', async (request): Promise<ClaudeAccountListDto> => {
    const user = requireUser(request)
    return { accounts: accounts.list(user.id) }
  })

  app.post('/api/claude-accounts', async (request, reply): Promise<ClaudeAccount> => {
    const user = requireUser(request)
    const body = createClaudeAccountBodySchema.parse(request.body)
    if (!accounts.labelFree(user.id, body.label)) throw taken()

    reply.status(201)
    return accounts.create(user.id, body.label, body.token)
  })

  app.patch('/api/claude-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateClaudeAccountBodySchema.parse(request.body)
    if (body.label !== undefined && !accounts.labelFree(user.id, body.label, id)) throw taken()

    if (!accounts.update(user.id, id, body)) {
      throw notFound('claude_account_not_found', 'Unknown Claude account.')
    }
    reply.status(204)
  })

  /**
   * Les conversations qui désignaient ce compte gardent son identifiant : elles
   * repartiront sur la connexion du CLI, avec un avis dans le fil, plutôt que d'être
   * injouables. Les retoucher ici reviendrait à réécrire des configurations une à une.
   */
  app.delete('/api/claude-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    if (!accounts.delete(user.id, id)) {
      throw notFound('claude_account_not_found', 'Unknown Claude account.')
    }
    reply.status(204)
  })
}
