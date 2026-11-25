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
