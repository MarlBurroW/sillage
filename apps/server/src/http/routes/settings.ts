import type { FastifyInstance } from 'fastify'
import { updateAppSettingsBodySchema, type AppSettingsDto } from '@sillage/protocol'
import { readAppSettings, writeAppSettings } from '../../settings/app-settings.js'
import type { AppContext } from '../context.js'
import { requireAdmin, requireUser } from '../require-user.js'

/**
 * Réglages de l'instance.
 *
 * Lecture ouverte à tout compte connecté, à la différence des secrets : le délai
 * d'archivage décrit un comportement que chacun subit sur ses propres fils, et le
 * cacher à qui n'administre pas ne protégerait rien.
 */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
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
    return readAppSettings(ctx.db, ctx.config)
  })
}
