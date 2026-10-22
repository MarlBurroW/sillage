import type { FastifyInstance } from 'fastify'
import { updateUserSettingsBodySchema, type UserSettingsDto } from '@sillage/protocol'
import {
  readUserSettings,
  writeAppearance,
  writeCollapsedProjects,
  writeComposerLayout,
  writeHiddenAgents,
  writeBoardOrder,
  writeNotificationPrefs,
  writeOnboarding,
  writeProjectDefaults,
  writeProjectsDir,
  writeUserAgentDefault,
} from '../../settings/user-settings.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../require-user.js'

/** Signed-in account settings. No reading or writing other accounts' settings, including by administrators: these are preferences rather than policy, and nobody should choose the model a colleague starts conversations with. */
export function registerUserSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/me/settings', async (request): Promise<UserSettingsDto> => {
    const user = requireUser(request)
    return readUserSettings(ctx.db, user.id)
  })

  app.patch('/api/me/settings', async (request): Promise<UserSettingsDto> => {
    const user = requireUser(request)
    const body = updateUserSettingsBodySchema.parse(request.body)

    // All fields are optional: the defaults panel and sidebar write the same document
    // without addressing each other's settings.
    if (body.agentDefault) writeUserAgentDefault(ctx.db, user.id, body.agentDefault)
    if (body.collapsedProjects) writeCollapsedProjects(ctx.db, user.id, body.collapsedProjects)
    if (body.hiddenAgents) writeHiddenAgents(ctx.db, user.id, body.hiddenAgents)
    if (body.boardOrder) writeBoardOrder(ctx.db, user.id, body.boardOrder.projectId, body.boardOrder.order)
    if (body.projectsDir !== undefined) writeProjectsDir(ctx.db, user.id, body.projectsDir)
    if (body.appearance) writeAppearance(ctx.db, user.id, body.appearance)
    if (body.notifications) writeNotificationPrefs(ctx.db, user.id, body.notifications)
    if (body.composerLayout) writeComposerLayout(ctx.db, user.id, body.composerLayout)
    if (body.onboarding) writeOnboarding(ctx.db, user.id, body.onboarding)
    if (body.projectDefaults) writeProjectDefaults(ctx.db, user.id, body.projectDefaults)
    // Reread rather than rebuild from the body: the screen needs both CLIs, and
    // the body includes only one.
    return readUserSettings(ctx.db, user.id)
  })
}
