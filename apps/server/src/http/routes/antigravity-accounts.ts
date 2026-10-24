import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  createAntigravityAccountBodySchema,
  startAntigravityLoginBodySchema,
  updateAntigravityAccountBodySchema,
  type AntigravityAccount,
  type AntigravityAccountListDto,
  type AntigravityLoginStatusDto,
} from '@sillage/protocol'
import type { AntigravityLoginService } from '../../antigravity-accounts/login.js'
import type { AntigravityAccountStore } from '../../antigravity-accounts/store.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/** Additional Antigravity accounts belonging to the current user. Same contract as Codex accounts: per Sillage account, with Antigravity authenticating inside the account home. Routes send API keys one way and never return secrets. */
export function registerAntigravityAccountRoutes(
  app: FastifyInstance,
  accounts: AntigravityAccountStore,
  login: AntigravityLoginService,
): void {
  const taken = () =>
    new HttpError(409, 'antigravity_account_label_taken', 'Another account already has this name.')
  const owned = (userId: string, id: string): AntigravityAccount => {
    const account = accounts.find(userId, id)
    if (!account) throw notFound('antigravity_account_not_found', 'Unknown Antigravity account.')
    return account
  }
  /** Preserve Antigravity's rejection verbatim: it knows the reason. */
  const antigravityRefused = (err: unknown) =>
    new HttpError(502, 'antigravity_login_failed', 'Antigravity could not sign in: {error}.', {
      error: err instanceof Error ? err.message : String(err),
    })

  app.get('/api/antigravity-accounts', async (request): Promise<AntigravityAccountListDto> => {
    const user = requireUser(request)
    return { accounts: accounts.list(user.id) }
  })

  app.post('/api/antigravity-accounts', async (request, reply): Promise<AntigravityAccount> => {
    const user = requireUser(request)
    const body = createAntigravityAccountBodySchema.parse(request.body)
    if (!accounts.labelFree(user.id, body.label)) throw taken()
    reply.status(201)
    return accounts.create(user.id, body.label)
  })

  app.patch('/api/antigravity-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateAntigravityAccountBodySchema.parse(request.body)
    owned(user.id, id)
    if (!accounts.labelFree(user.id, body.label, id)) throw taken()
    accounts.rename(user.id, id, body.label)
    reply.status(204)
  })

  app.delete('/api/antigravity-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    await login.forget(id)
    accounts.delete(user.id, id)
    reply.status(204)
  })

  /** Starts native authentication asynchronously. Google owns OAuth; polling exposes only the URL and outcome. */
  app.post('/api/antigravity-accounts/:id/login', async (request): Promise<AntigravityLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = startAntigravityLoginBodySchema.parse(request.body)
    owned(user.id, id)
    try {
      return await login.start(id, body)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw antigravityRefused(err)
    }
  })

  app.post('/api/antigravity-accounts/:id/callback', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    const { url } = z.object({ url: z.string().max(16_384).url() }).parse(request.body)
    try { await login.callback(id, url) } catch (err) { throw antigravityRefused(err) }
    reply.status(204)
  })

  app.get('/api/antigravity-accounts/:id/login', async (request): Promise<AntigravityLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    return login.status(id)
  })

  app.delete('/api/antigravity-accounts/:id/login', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const account = owned(user.id, id)
    try {
      // Cancel pending logins; log out homes that are already authenticated.
      if (login.status(id).state === 'pending') await login.cancel(id)
      else if (account.status === 'ready') await login.logout(id)
    } catch (err) {
      throw antigravityRefused(err)
    }
    reply.status(204)
  })
}
