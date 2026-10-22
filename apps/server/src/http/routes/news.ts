import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { newsPreferencesSchema } from '@sillage/protocol'
import { feedUrl, FeedError } from '../../news/fetch.js'
import { NewsService } from '../../news/service.js'
import { readUserSettings, writeNewsPreferences } from '../../settings/user-settings.js'
import type { AppContext } from '../context.js'
import { badRequest, HttpError } from '../errors.js'
import { requireUser } from '../require-user.js'

export function registerNewsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const news = new NewsService(ctx.db)
  const attempts = new Map<string, { count: number; until: number }>()
  app.addHook('onReady', async () => { news.start() })
  app.addHook('onClose', async () => { await news.stop() })
  app.get('/api/news', async (request) => news.read(requireUser(request).id))
  app.put('/api/me/news', async (request) => {
    const user = requireUser(request)
    const prefs = newsPreferencesSchema.parse(request.body)
    try {
      prefs.sources = [...new Map(prefs.sources.map((source) => {
        const url = feedUrl(source.url).href
        return [url, { ...source, url }] as const
      })).values()]
    } catch { throw badRequest('news_url', 'Use a public HTTP or HTTPS feed URL without credentials.') }
    writeNewsPreferences(ctx.db, user.id, prefs)
    if (prefs.enabled) void news.refreshSubscribed().catch((err: unknown) => app.log.warn({ err }, 'News refresh failed'))
    return readUserSettings(ctx.db, user.id)
  })
  app.post('/api/news/preview', async (request) => {
    const user = requireUser(request)
    const { url } = z.object({ url: z.string().max(2048) }).parse(request.body)
    const now = Date.now()
    for (const [id, attempt] of attempts) if (attempt.until <= now) attempts.delete(id)
    const attempt = attempts.get(user.id) ?? { count: 0, until: now + 60000 }
    attempts.set(user.id, attempt)
    if (++attempt.count > 10) throw new HttpError(429, 'news_busy', 'Too many feed checks. Try again shortly.')
    try { return await news.preview(url) }
    catch (err) { throw badRequest(err instanceof FeedError ? err.code : 'news_fetch', 'The feed could not be read.') }
  })
}
