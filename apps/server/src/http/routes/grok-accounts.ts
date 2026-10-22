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

/** Additional Grok accounts belonging to the current user. Same contract as Codex accounts: per Sillage account, with Grok authenticating inside the account home. Routes send API keys one way and never return secrets. */
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
  /** Preserve Grok's rejection verbatim: it knows the reason. */
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

  /** Starts login. Device-code responses include the URL and code; progress is read through `GET …/login`. API-key login is complete when this returns. */
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
      // Cancel pending logins; log out homes that are already authenticated.
      if (login.status(id).state === 'pending') await login.cancel(id)
      else if (account.status === 'ready') await login.logout(id)
    } catch (err) {
      throw grokRefused(err)
    }
    reply.status(204)
  })
}
