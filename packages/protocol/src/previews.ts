import { z } from 'zod'

/**
 * Dev-server previews (card #113): open what an agent's dev server serves inside Sillage.
 *
 * Server proxies it on a host of its own (`pv-<id>.<preview domain>`), never on Sillage's origin:
 * the app's scripts must not be able to call Sillage's API with the viewer's session. Desktop
 * points at the loopback port directly, which already is another origin.
 */

/** Label prefix of preview hosts; a reverse proxy routes `pv-*.<domain>` to the preview listener. */
export const PREVIEW_HOST_PREFIX = 'pv-'

/**
 * How this instance shows previews: through its preview listener, straight to loopback (Desktop),
 * or not until an administrator sets a preview domain.
 */
export type PreviewMode = 'proxy' | 'direct' | 'unconfigured'

/** A listening port the account may preview, with what opened it. */
export interface PreviewTargetDto {
  port: number
  /** What listens: an app unit's description, or the process name. */
  label: string
  /** Shortened command line, when known. */
  command: string | null
  projectId: string | null
  conversationId: string | null
  conversationTitle: string | null
}

export interface PreviewListDto {
  mode: PreviewMode
  /** The domain previews are served under, for the settings screen. */
  domain: string
  /** Port the preview listener uses on loopback, for the reverse proxy configuration. */
  listenerPort: number | null
  targets: PreviewTargetDto[]
}

export const openPreviewBodySchema = z.object({
  port: z.number().int().min(1).max(65535),
})

export interface PreviewOpenDto {
  /** Address to load in the frame or a tab; in proxy mode it carries a short sign-in token. */
  url: string
  /** Address without the token, stable while the preview lives (to show and copy). */
  address: string
}

/** Lifetimes offered for a public demo link, in hours: an hour, a day, a week, a month. */
export const PREVIEW_SHARE_HOURS = [1, 24, 168, 720] as const

export const createPreviewShareBodySchema = z.object({
  port: z.number().int().min(1).max(65535),
  hours: z.union(PREVIEW_SHARE_HOURS.map((hours) => z.literal(hours)) as [z.ZodLiteral<1>, z.ZodLiteral<24>, z.ZodLiteral<168>, z.ZodLiteral<720>]),
})

/** A public demo link: anyone with the address sees the app, without a Sillage account. */
export interface PreviewShareDto {
  id: string
  url: string
  port: number
  label: string
  projectId: string | null
  createdAt: number
  expiresAt: number
  revokedAt: number | null
}

export interface PreviewShareListDto {
  shares: PreviewShareDto[]
}
