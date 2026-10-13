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
 * Comptes Codex supplémentaires de l'utilisateur courant.
 *
 * Par compte Sillage et non par instance, comme les comptes Claude. La connexion
 * elle-même est menée par Codex dans le home du compte : les routes ne transportent
 * qu'une clé API à l'aller, jamais rien au retour.
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
  /** Ce que Codex a refusé, tel quel : c'est lui qui sait pourquoi. */
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
   * Lance la connexion. Par code d'appareil, la réponse porte l'URL et le code, et la
   * suite se lit par `GET …/login` ; par clé API, tout est fait au retour.
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
      // Une attente en cours s'annule ; un home connecté se déconnecte.
      if (login.status(id).state === 'pending') await login.cancel(id)
      else if (account.status === 'ready') await login.logout(id)
    } catch (err) {
      throw codexRefused(err)
    }
    reply.status(204)
  })
}
