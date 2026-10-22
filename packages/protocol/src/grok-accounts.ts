import { z } from 'zod'

/**
 * Additional Grok Build accounts per user.
 *
 * Grok keeps one login per `GROK_HOME` in `auth.json`. As with Codex, each additional account
 * gets its own home, where only login and account-dependent data (model catalog, remote
 * settings) are real. Everything else (sessions, config.toml, memory, skills) links to the
 * user's home so switching accounts changes only the paying subscription, not settings or
 * sessions.
 *
 * Sillage stores no secrets itself: Grok runs in that home to log in through device code (`grok
 * login --device-auth`) or API key, and writes `auth.json` itself.
 */

export const grokAccountLabelSchema = z.string().trim().min(1).max(60)

export const grokAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** `pending` until a login succeeds in its home. */
  status: z.enum(['pending', 'ready']),
  /** `grok` for a subscription authenticated through grok.com; `apiKey` for an xAI key. */
  authMode: z.enum(['grok', 'apiKey']).nullable(),
  /** Email read during grok.com login; null for API keys. */
  email: z.string().nullable(),
  /** Plan reported by Grok billing (“X Premium”, “SuperGrok”, etc.). */
  plan: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type GrokAccount = z.infer<typeof grokAccountSchema>

export const createGrokAccountBodySchema = z.object({ label: grokAccountLabelSchema })
export const updateGrokAccountBodySchema = z.object({ label: grokAccountLabelSchema })

/**
 * Two home login methods: device code for a subscription without a browser on the server, or an
 * xAI API key.
 */
export const startGrokLoginBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('deviceCode') }),
  z.object({ type: z.literal('apiKey'), apiKey: z.string().trim().min(1) }),
])

/** Account login progress, with the same shape as Codex accounts. */
export interface GrokLoginStatusDto {
  state: 'idle' | 'pending' | 'done' | 'failed'
  verificationUrl: string | null
  userCode: string | null
  error: string | null
}

export interface GrokAccountListDto {
  accounts: GrokAccount[]
}
