import type { AppContext } from '../http/context.js'
import { publicUrlOf } from '../settings/app-settings.js'

/**
 * Address public links are built on, without a trailing slash; empty when the instance cannot
 * publish. A link only makes sense on an address someone else can reach: no public sharing
 * capability (Desktop), no configured address or a loopback one all mean "cannot publish".
 */
export function publicShareRoot(ctx: Pick<AppContext, 'db' | 'config'>, enabled: boolean): string {
  if (!enabled) return ''
  const value = publicUrlOf(ctx.db, ctx.config)
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return ''
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return ''
    return url.href.replace(/\/$/, '')
  } catch {
    return ''
  }
}
