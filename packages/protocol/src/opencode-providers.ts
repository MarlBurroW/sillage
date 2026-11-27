import { z } from 'zod'

/**
 * Model providers connected to OpenCode 2, managed from Sillage (Settings › OpenCode providers).
 *
 * OpenCode keeps the credentials itself, in its database for the machine's user: Sillage passes
 * a typed key straight to `POST /api/integration/{id}/connect/key` on a disposable server and
 * never stores or returns one. A connection serves every conversation on the machine, so it is
 * global configuration and belongs to administrators (scope rule).
 */

/** How a provider is reached right now: a saved credential, or an environment variable. */
export type OpencodeConnectionDto =
  | { type: 'credential'; id: string; label: string; method: 'key' | 'oauth' | 'external' }
  | { type: 'env'; name: string }

export interface OpencodeProviderDto {
  id: string
  name: string
  /** The provider takes an API key; other methods (OAuth, device codes) are not offered yet. */
  acceptsKey: boolean
  connections: OpencodeConnectionDto[]
}

export interface OpencodeProviderListDto {
  providers: OpencodeProviderDto[]
}

export const connectOpencodeKeyBodySchema = z.object({
  key: z.string().trim().min(1).max(4096),
  /** Shown in OpenCode's own lists; the provider name when absent. */
  label: z.string().trim().max(60).optional(),
})
