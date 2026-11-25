import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { TurnUsageRecorder } from '../../consumption/recorder.js'
import { consumptionReport } from '../../consumption/report.js'
import { conversationStats } from '../../conversations/stats.js'
import { readableConversation } from '../../conversations/access.js'
import type { PriceCatalog } from '../../pricing/catalog.js'
import type { AppContext } from '../context.js'
import { badRequest } from '../errors.js'
import { requireAdmin, requireUser } from '../require-user.js'

const rangeSchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  tz: z.string().max(64).default('UTC'),
})

export function registerConsumptionRoutes(app: FastifyInstance, ctx: AppContext, prices: PriceCatalog, usage: TurnUsageRecorder): void {
  // Deliberately the whole instance for every account: the dashboard answers "what does this
  // machine consume", and its figures name projects without opening them.
  app.get('/api/consumption', async (request) => {
    requireUser(request)
    const query = rangeSchema.parse(request.query)
    try { new Intl.DateTimeFormat('en-CA', { timeZone: query.tz }) } catch { throw badRequest('time_zone', 'Unknown time zone.') }
    return consumptionReport(ctx.db, prices, { from: query.from ?? null, to: query.to ?? Date.now(), timeZone: query.tz }, usage.historyReady())
  })

  // Here rather than with the conversation routes because pricing lives here; the conversation
  // itself stays behind the usual read check.
  app.get('/api/conversations/:id/stats', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    readableConversation(ctx.db, id, user.id)
    return conversationStats(ctx.db, prices, id)
  })

  // The price list is shared by the instance: asking for it again is the admin's call.
  app.post('/api/consumption/prices/refresh', async (request) => {
    requireAdmin(request)
    await prices.refresh()
    return prices.status()
  })
}
