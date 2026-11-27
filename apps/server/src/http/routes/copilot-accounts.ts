import type { FastifyInstance } from 'fastify'
import {
  createCopilotAccountBodySchema,
  updateCopilotAccountBodySchema,
  type CopilotAccount,
  type CopilotAccountListDto,
  type CopilotLoginStatusDto,
} from '@sillage/protocol'
import type { CopilotLoginService } from '../../copilot-accounts/login.js'
import type { CopilotAccountStore } from '../../copilot-accounts/store.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/** Additional Copilot accounts belonging to the current user. Same contract as Grok accounts: per Sillage account, with Copilot signing in inside the account home. No secret goes through these routes. */
export function registerCopilotAccountRoutes(
  app: FastifyInstance,
  accounts: CopilotAccountStore,
  login: CopilotLoginService,
): void {
  const taken = () =>
    new HttpError(409, 'copilot_account_label_taken', 'Another account already has this name.')
  const owned = (userId: string, id: string): CopilotAccount => {
    const account = accounts.find(userId, id)
    if (!account) throw notFound('copilot_account_not_found', 'Unknown Copilot account.')
    return account
  }
  /** Preserve Copilot's rejection verbatim: it knows the reason. */
  const copilotRefused = (err: unknown) =>
    new HttpError(502, 'copilot_login_failed', 'GitHub Copilot could not sign in: {error}.', {
      error: err instanceof Error ? err.message : String(err),
    })

  app.get('/api/copilot-accounts', async (request): Promise<CopilotAccountListDto> => {
    const user = requireUser(request)
    return { accounts: accounts.list(user.id) }
  })

  app.post('/api/copilot-accounts', async (request, reply): Promise<CopilotAccount> => {
    const user = requireUser(request)
    const body = createCopilotAccountBodySchema.parse(request.body)
    if (!accounts.labelFree(user.id, body.label)) throw taken()
    reply.status(201)
    return accounts.create(user.id, body.label)
  })

  app.patch('/api/copilot-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateCopilotAccountBodySchema.parse(request.body)
    owned(user.id, id)
    if (!accounts.labelFree(user.id, body.label, id)) throw taken()
    accounts.rename(user.id, id, body.label)
    reply.status(204)
  })

  app.delete('/api/copilot-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    await login.forget(id)
    accounts.delete(user.id, id)
    reply.status(204)
  })

  /** Starts a device-code sign-in; the response carries the URL and code, and progress is read through `GET …/login`. */
  app.post('/api/copilot-accounts/:id/login', async (request): Promise<CopilotLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    try {
      return await login.startDeviceCode(id)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw copilotRefused(err)
    }
  })

  app.get('/api/copilot-accounts/:id/login', async (request): Promise<CopilotLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    return login.status(id)
  })

  app.delete('/api/copilot-accounts/:id/login', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const account = owned(user.id, id)
    try {
      // Cancel pending logins; log out homes that are already authenticated.
      if (login.status(id).state === 'pending') await login.cancel(id)
      else if (account.status === 'ready') await login.logout(id)
    } catch (err) {
      throw copilotRefused(err)
    }
    reply.status(204)
  })
}
