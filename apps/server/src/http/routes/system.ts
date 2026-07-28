import type { FastifyInstance } from 'fastify'
import type { UpdateStatus, VersionInfo } from '@sillage/protocol'
import { UpdateError, UpdateExecutor } from '../../update/executor.js'
import { ReleaseChecker } from '../../update/release-checker.js'
import { HttpError } from '../errors.js'
import { requireAdmin, requireUser } from '../require-user.js'

/**
 * Version installée, disponibilité d'une mise à jour et pilotage de celle-ci.
 * La vérification est visible de tout utilisateur connecté ; seul un
 * administrateur peut forcer un rafraîchissement ou lancer la mise à jour.
 */
export function registerSystemRoutes(app: FastifyInstance): void {
  const checker = new ReleaseChecker()
  const executor = new UpdateExecutor(checker, app.log)

  app.get<{ Querystring: { refresh?: string } }>(
    '/api/system/version',
    async (request): Promise<VersionInfo> => {
      const refresh = request.query.refresh === '1'
      if (refresh) requireAdmin(request)
      else requireUser(request)
      return checker.getVersionInfo(refresh)
    },
  )

  app.post('/api/system/update', async (request, reply): Promise<UpdateStatus> => {
    requireAdmin(request)
    // La cible vient de l'état serveur, pas du client : on met toujours à jour
    // vers la dernière release connue, jamais vers une version arbitraire.
    const info = await checker.getVersionInfo()
    if (!info.updateAvailable || !info.latest) {
      throw new HttpError(409, 'no_update', 'No update is available.')
    }
    try {
      executor.start(info.latest)
    } catch (err) {
      if (err instanceof UpdateError) throw new HttpError(409, err.code, err.message)
      throw err
    }
    return reply.status(202).send(executor.getStatus())
  })

  app.get('/api/system/update/status', async (request): Promise<UpdateStatus> => {
    requireUser(request)
    return executor.getStatus()
  })
}
