import type { FastifyInstance } from 'fastify'
import {
  createGrokAccountBodySchema,
  startGrokLoginBodySchema,
  updateGrokAccountBodySchema,
  type GrokAccount,
  type GrokAccountListDto,
  type GrokLoginStatusDto,
} from '@sillage/protocol'
import type { GrokLoginService } from '../../grok-accounts/login.js'
import type { GrokAccountStore } from '../../grok-accounts/store.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Comptes Grok supplémentaires de l'utilisateur courant.
 *
 * Même contrat que les comptes Codex : par compte Sillage, et la connexion est menée par
 * Grok dans le home du compte. Les routes ne transportent qu'une clé API à l'aller,
 * jamais rien au retour.
 */
export function registerGrokAccountRoutes(
  app: FastifyInstance,
  accounts: GrokAccountStore,
  login: GrokLoginService,
): void {
  const taken = () =>
    new HttpError(409, 'grok_account_label_taken', 'Another account already has this name.')
  const owned = (userId: string, id: string): GrokAccount => {
    const account = accounts.find(userId, id)
    if (!account) throw notFound('grok_account_not_found', 'Unknown Grok account.')
    return account
  }
  /** Ce que Grok a refusé, tel quel : c'est lui qui sait pourquoi. */
  const grokRefused = (err: unknown) =>
    new HttpError(502, 'grok_login_failed', 'Grok could not sign in: {error}.', {
      error: err instanceof Error ? err.message : String(err),
    })

  app.get('/api/grok-accounts', async (request): Promise<GrokAccountListDto> => {
    const user = requireUser(request)
    return { accounts: accounts.list(user.id) }
  })

  app.post('/api/grok-accounts', async (request, reply): Promise<GrokAccount> => {
    const user = requireUser(request)
    const body = createGrokAccountBodySchema.parse(request.body)
    if (!accounts.labelFree(user.id, body.label)) throw taken()
    reply.status(201)
    return accounts.create(user.id, body.label)
  })

  app.patch('/api/grok-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateGrokAccountBodySchema.parse(request.body)
    owned(user.id, id)
    if (!accounts.labelFree(user.id, body.label, id)) throw taken()
    accounts.rename(user.id, id, body.label)
    reply.status(204)
  })

  app.delete('/api/grok-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    await login.forget(id)
    accounts.delete(user.id, id)
    reply.status(204)
  })

  /**
   * Lance la connexion. Par code d'appareil, la réponse porte l'URL et le code, et la
   * suite se lit par `GET …/login` ; par clé API, tout est fait au retour.
   */
  app.post('/api/grok-accounts/:id/login', async (request): Promise<GrokLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = startGrokLoginBodySchema.parse(request.body)
    owned(user.id, id)
    try {
      if (body.type === 'apiKey') {
        await login.loginWithApiKey(id, body.apiKey)
        return login.status(id)
      }
      return await login.startDeviceCode(id)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw grokRefused(err)
    }
  })

  app.get('/api/grok-accounts/:id/login', async (request): Promise<GrokLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    return login.status(id)
  })

  app.delete('/api/grok-accounts/:id/login', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const account = owned(user.id, id)
    try {
      // Une attente en cours s'annule ; un home connecté se déconnecte.
      if (login.status(id).state === 'pending') await login.cancel(id)
      else if (account.status === 'ready') await login.logout(id)
    } catch (err) {
      throw grokRefused(err)
    }
    reply.status(204)
  })
}
