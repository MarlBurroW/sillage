import type { FastifyInstance } from 'fastify'
import {
  createCodexAccountBodySchema,
  startCodexLoginBodySchema,
  updateCodexAccountBodySchema,
  type CodexAccount,
  type CodexAccountListDto,
  type CodexLoginStatusDto,
} from '@sillage/protocol'
import type { CodexLoginService } from '../../codex-accounts/login.js'
import type { CodexAccountStore } from '../../codex-accounts/store.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Additional Codex accounts belonging to the current user.
 *
 * Per Sillage account rather than instance, like Claude accounts. Codex handles
 * authentication inside the account home: routes send API keys one way and
 * never return secrets.
 */
export function registerCodexAccountRoutes(
  app: FastifyInstance,
  accounts: CodexAccountStore,
  login: CodexLoginService,
): void {
  const taken = () =>
    new HttpError(409, 'codex_account_label_taken', 'Another account already has this name.')
  const owned = (userId: string, id: string): CodexAccount => {
    const account = accounts.find(userId, id)
    if (!account) throw notFound('codex_account_not_found', 'Unknown Codex account.')
    return account
  }
  /** Preserve Codex's rejection verbatim: it knows the reason. */
  const codexRefused = (err: unknown) =>
    new HttpError(502, 'codex_login_failed', 'Codex could not sign in: {error}.', {
      error: err instanceof Error ? err.message : String(err),
    })

  app.get('/api/codex-accounts', async (request): Promise<CodexAccountListDto> => {
    const user = requireUser(request)
    return { accounts: accounts.list(user.id) }
  })

  app.post('/api/codex-accounts', async (request, reply): Promise<CodexAccount> => {
    const user = requireUser(request)
    const body = createCodexAccountBodySchema.parse(request.body)
    if (!accounts.labelFree(user.id, body.label)) throw taken()
    reply.status(201)
    return accounts.create(user.id, body.label)
  })

  app.patch('/api/codex-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateCodexAccountBodySchema.parse(request.body)
    owned(user.id, id)
    if (!accounts.labelFree(user.id, body.label, id)) throw taken()
    accounts.rename(user.id, id, body.label)
    reply.status(204)
  })

  app.delete('/api/codex-accounts/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    await login.forget(id)
    accounts.delete(user.id, id)
    reply.status(204)
  })

  /**
   * Starts login. Device-code responses include a URL and code; progress is read
   * through `GET …/login`. API-key login is complete when this returns.
   */
  app.post('/api/codex-accounts/:id/login', async (request): Promise<CodexLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = startCodexLoginBodySchema.parse(request.body)
    owned(user.id, id)
    try {
      if (body.type === 'apiKey') {
        await login.loginWithApiKey(id, body.apiKey)
        return login.status(id)
      }
      return await login.startDeviceCode(id)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw codexRefused(err)
    }
  })

  app.get('/api/codex-accounts/:id/login', async (request): Promise<CodexLoginStatusDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    owned(user.id, id)
    return login.status(id)
  })

  app.delete('/api/codex-accounts/:id/login', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const account = owned(user.id, id)
    try {
      // Cancel pending logins; log out homes that are already authenticated.
      if (login.status(id).state === 'pending') await login.cancel(id)
      else if (account.status === 'ready') await login.logout(id)
    } catch (err) {
      throw codexRefused(err)
    }
    reply.status(204)
  })
}
