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
 * Additional Claude accounts belonging to the current user.
 *
 * Per Sillage account rather than instance, like git credentials: `setup-token`
 * tokens and API keys charge someone's subscription or bill. Each user can see
 * and modify only their own accounts, including administrators.
 *
 * No route returns secrets. Expired secrets are replaced in full, ordinarily
 * after a year for tokens.
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
   * Guided subscription login: runs `claude setup-token` and returns the URL to
   * open. The displayed code comes back through the next route; the account is
   * created when the CLI prints its token.
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
   * Usage gauge for an existing subscription: `claude auth login`, tracked by
   * `/login/:loginId` like guided login. API keys have no subscription allowance.
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
   * Conversations targeting this account retain its ID: they fall back to CLI
   * authentication with a notice rather than becoming unusable. Updating them
   * here would mean rewriting individual configurations.
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
