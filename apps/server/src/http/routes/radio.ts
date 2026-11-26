import type { FastifyInstance } from 'fastify'
import { CLAUDE_FM_LINK, youtubeVideoId, type RadioStationDto } from '@sillage/protocol'
import { readUserSettings } from '../../settings/user-settings.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../require-user.js'

/**
 * The radio in the rail: Claude FM unless the account chose another YouTube link.
 *
 * Claude Code's /radio only opens CLAUDE_FM_LINK in a browser; it redirects to a YouTube live whose
 * video changes whenever the stream restarts, so the server follows it rather than the web
 * hard-coding a video.
 */
/** Live seen on 26 Nov 2026 (Claude Code 2.1.318), used while the link cannot be followed. */
const FALLBACK_VIDEO = 'tRsQsTMvPNg'
const FRESH_MS = 30 * 60_000
const RETRY_MS = 60_000
/** Titles of chosen videos, bounded: each account may pick its own. */
const MAX_TITLES = 200

let claudeFm: { videoId: string; until: number } | null = null
const titles = new Map<string, { title: string | null; until: number }>()

export function registerRadioRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/radio', async (request): Promise<RadioStationDto> => {
    const user = requireUser(request)
    const chosen = readUserSettings(ctx.db, user.id).radioUrl
    const videoId = chosen ? youtubeVideoId(chosen) : null
    if (chosen && videoId) return { videoId, link: chosen, title: await titleOf(videoId), custom: true }

    if (!claudeFm || claudeFm.until <= Date.now()) {
      const live = await followClaudeFm().catch(() => null)
      // A failed lookup is retried soon rather than pinned for the full period.
      claudeFm = live ? { videoId: live, until: Date.now() + FRESH_MS } : { videoId: claudeFm?.videoId ?? FALLBACK_VIDEO, until: Date.now() + RETRY_MS }
    }
    return { videoId: claudeFm.videoId, link: CLAUDE_FM_LINK, title: 'Claude FM', custom: false }
  })
}

async function followClaudeFm(): Promise<string | null> {
  const response = await fetch(CLAUDE_FM_LINK, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const location = response.headers.get('location')
  return location ? youtubeVideoId(new URL(location, CLAUDE_FM_LINK).href) : null
}

/** Asked of YouTube's oEmbed endpoint, a fixed host: the user's link itself is never fetched. */
async function titleOf(videoId: string): Promise<string | null> {
  const cached = titles.get(videoId)
  if (cached && cached.until > Date.now()) return cached.title
  let title: string | null = null
  try {
    const watch = `https://www.youtube.com/watch?v=${videoId}`
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, { signal: AbortSignal.timeout(5000) })
    if (response.ok) {
      const body = await response.json() as { title?: unknown }
      if (typeof body.title === 'string') title = body.title.slice(0, 200)
    }
  } catch { /* Untitled: the rail falls back to a generic name. */ }
  if (titles.size >= MAX_TITLES) titles.delete(titles.keys().next().value!)
  titles.set(videoId, { title, until: Date.now() + (title ? FRESH_MS : RETRY_MS) })
  return title
}
