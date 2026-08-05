import type { FastifyInstance } from 'fastify'
import { updateUserSettingsBodySchema, type UserSettingsDto } from '@sillage/protocol'
import { readUserSettings, writeUserAgentDefault } from '../../settings/user-settings.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../require-user.js'

/**
 * Réglages du compte connecté.
 *
 * Ni lecture ni écriture pour un autre compte, administrateur compris : ce sont des
 * préférences, pas une politique, et personne n'a à décider avec quel modèle un
 * collègue ouvre ses conversations.
 */
export function registerUserSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/me/settings', async (request): Promise<UserSettingsDto> => {
    const user = requireUser(request)
    return readUserSettings(ctx.db, user.id)
  })

  app.patch('/api/me/settings', async (request): Promise<UserSettingsDto> => {
    const user = requireUser(request)
    const body = updateUserSettingsBodySchema.parse(request.body)

    writeUserAgentDefault(ctx.db, user.id, body.agentDefault)
    // Relu plutôt que reconstruit depuis le corps : l'écran a besoin des deux CLI, et
    // le corps n'en porte qu'un.
    return readUserSettings(ctx.db, user.id)
  })
}
