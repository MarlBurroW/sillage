import type { FastifyInstance } from 'fastify'
import {
  createClaudeAccountBodySchema,
  startClaudeLoginBodySchema,
  submitClaudeLoginCodeBodySchema,
  updateClaudeAccountBodySchema,
  type ClaudeAccount,
  type ClaudeAccountListDto,
  type ClaudeLoginStatusDto,
} from '@sillage/protocol'
import type { ClaudeLoginService } from '../../claude-accounts/login.js'
import type { ClaudeAccountStore } from '../../claude-accounts/store.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Comptes Claude supplémentaires de l'utilisateur courant.
 *
 * Par compte Sillage et non par instance, comme les credentials git : un jeton de
 * `setup-token` ou une clé API engage l'abonnement ou la facture de quelqu'un.
 * Chacun ne voit et ne modifie que les siens, administrateur compris.
 *
 * Aucune route ne rend un secret. Il se remplace entier quand il expire, au bout d'un
 * an pour un jeton, ce qui est le geste courant.
 */
export function registerClaudeAccountRoutes(
  app: FastifyInstance,
  accounts: ClaudeAccountStore,
  login: ClaudeLoginService,
): void {
  const taken = () =>
    new HttpError(409, 'claude_account_label_taken', 'Another account already has this name.')
  const unknownLogin = () => notFound('claude_login_not_found', 'Unknown sign-in.')

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

  /**
   * Connexion guidée d'un abonnement : lance `claude setup-token`, rend l'URL à
   * ouvrir ; le code que la page affiche revient par la route suivante, et le compte
   * naît quand le CLI a imprimé le jeton.
   */
  app.post('/api/claude-accounts/login', async (request, reply): Promise<ClaudeLoginStatusDto> => {
    const user = requireUser(request)
    const body = startClaudeLoginBodySchema.parse(request.body)
    if (!accounts.labelFree(user.id, body.label)) throw taken()
    reply.status(201)
    return login.start(user.id, body.label)
  })

  app.get('/api/claude-accounts/login/:loginId', async (request): Promise<ClaudeLoginStatusDto> => {
    const user = requireUser(request)
    const { loginId } = request.params as { loginId: string }
    const status = login.status(user.id, loginId)
    if (!status) throw unknownLogin()
    return status
  })

  app.post('/api/claude-accounts/login/:loginId/code', async (request): Promise<ClaudeLoginStatusDto> => {
    const user = requireUser(request)
    const { loginId } = request.params as { loginId: string }
    const body = submitClaudeLoginCodeBodySchema.parse(request.body)
    const status = login.submitCode(user.id, loginId, body.code)
    if (!status) throw unknownLogin()
    return status
  })

  app.delete('/api/claude-accounts/login/:loginId', async (request, reply) => {
    const user = requireUser(request)
    const { loginId } = request.params as { loginId: string }
    if (!(await login.cancel(user.id, loginId))) throw unknownLogin()
    reply.status(204)
  })

  /**
   * Jauge d'un abonnement existant : une connexion `claude auth login`, suivie comme la
   * connexion guidée, par les routes `/login/:loginId`. Une clé API n'a pas de forfait.
   */
  app.post('/api/claude-accounts/:id/gauge', async (request, reply): Promise<ClaudeLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const account = accounts.find(user.id, id)
    if (!account) throw notFound('claude_account_not_found', 'Unknown Claude account.')
    if (account.kind !== 'oauth') {
      throw new HttpError(400, 'claude_account_no_plan', 'An API key has no plan limits to read.')
    }
    reply.status(201)
    return login.startGauge(user.id, id, account.label)
  })

  app.delete('/api/claude-accounts/:id/gauge', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    if (!accounts.find(user.id, id)) throw notFound('claude_account_not_found', 'Unknown Claude account.')
    accounts.gauges?.forget(id)
    reply.status(204)
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
