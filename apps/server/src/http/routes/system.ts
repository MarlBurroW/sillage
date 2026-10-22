import { homedir, hostname } from 'node:os'
import { count } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { users } from '@sillage/db'
import type { InstanceInfo, UpdateStatus, VersionInfo } from '@sillage/protocol'
import { instanceInfo } from '../../instance/profile.js'
import type { AppContext } from '../context.js'
import { UpdateError, UpdateExecutor } from '../../update/executor.js'
import { ReleaseChecker } from '../../update/release-checker.js'
import { HttpError } from '../errors.js'
import { requireAdmin, requireUser } from '../require-user.js'

/** Installed version, update availability and update controls. Any signed-in user can check; only administrators can force a refresh or start an update. */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const checker = new ReleaseChecker()
  const executor = new UpdateExecutor(checker, app.log)

  // Public like health checks: the interface needs this before login, and the profile
  // reveals nothing visitors cannot infer from the screen. The absence of accounts
  // is equally visible: the login page would reveal it by rejecting everyone.
  app.get('/api/system/instance', async (): Promise<InstanceInfo> => {
    const info = instanceInfo()
    const [tally] = ctx.db.select({ total: count() }).from(users).all()
    return {
      ...info,
      needsSetup: info.profile === 'server' && (tally?.total ?? 0) === 0,
      hostname: hostname(),
      homeDir: homedir(),
    }
  })

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
    // The target comes from server state rather than the client: always update to
    // the latest known release, never an arbitrary version.
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
