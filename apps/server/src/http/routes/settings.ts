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
 * Réglages de l'instance.
 *
 * Lecture ouverte à tout compte connecté, à la différence des secrets : le délai
 * d'archivage décrit un comportement que chacun subit sur ses propres fils, et le
 * cacher à qui n'administre pas ne protégerait rien.
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
    // Rendu relu plutôt que reconstruit depuis le corps : un champ absent garde sa
    // valeur, et l'écran a besoin de l'état complet, pas de ce qu'il vient d'envoyer.
    const settings = readAppSettings(ctx.db, ctx.config)

    // Le délai se relit à chaque passage, mais le motif décide de quand ce passage a
    // lieu : sans réarmement, la nouvelle valeur attendrait le prochain redémarrage.
    scheduler.reschedule(ARCHIVE_JOB, settings.autoArchiveSchedule)

    return settings
  })

  /**
   * Le passage d'archivage, tout de suite.
   *
   * Un réglage dont l'effet n'arrive que le lendemain se règle à l'aveugle : lancer le
   * passage est le seul moyen de voir ce que le délai retenu range vraiment.
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
