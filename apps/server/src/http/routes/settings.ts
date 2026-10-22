import type { FastifyInstance } from 'fastify'
import {
  updateAppSettingsBodySchema,
  type AppSettingsDto,
  type ArchiveRunDto,
} from '@sillage/protocol'
import { runArchivePass } from '../../conversations/auto-archive.js'
import { ARCHIVE_JOB } from '../../scheduler/jobs.js'
import type { Scheduler } from '../../scheduler/scheduler.js'
import { readAppSettings, writeAppSettings } from '../../settings/app-settings.js'
import type { AppContext } from '../context.js'
import { badRequest } from '../errors.js'
import { requireAdmin, requireUser } from '../require-user.js'

/**
 * Instance settings.
 *
 * Any signed-in account can read them, unlike secrets: archival delays affect
 * everyone's conversations, and hiding them from non-administrators protects nothing.
 */
export function registerSettingsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  scheduler: Scheduler,
): void {
  app.get('/api/settings', async (request): Promise<AppSettingsDto> => {
    requireUser(request)
    return readAppSettings(ctx.db, ctx.config)
  })

  app.patch('/api/settings', async (request): Promise<AppSettingsDto> => {
    requireAdmin(request)
    const body = updateAppSettingsBodySchema.parse(request.body)

    writeAppSettings(ctx.db, body)
    // Reread rather than rebuild the response from the body: absent fields retain their
    // value, and the screen needs the complete state rather than its submitted patch.
    const settings = readAppSettings(ctx.db, ctx.config)

    // The delay is reread on each pass, but the schedule determines when passes run:
    // without rescheduling, the new value would wait until the next restart.
    scheduler.reschedule(ARCHIVE_JOB, settings.autoArchiveSchedule)

    return settings
  })

  /**
   * Runs an archival pass immediately.
   *
   * A setting whose effect appears tomorrow is configured blindly: running a pass
   * is the only way to see what the selected delay actually archives.
   */
  app.post('/api/settings/archiving/run', async (request): Promise<ArchiveRunDto> => {
    requireAdmin(request)

    const archived = runArchivePass(ctx.db, ctx.config)
    if (archived === null) {
      throw badRequest('auto_archive_disabled', 'Automatic archiving is off.')
    }

    return { archived }
  })
}
