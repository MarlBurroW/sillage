import { z } from 'zod'

/**
 * Additional Codex accounts per user.
 *
 * Codex keeps one login per `CODEX_HOME` in `auth.json`. Sillage gives each additional account
 * its own home, where only `auth.json` is real: everything else (config.toml, sessions, skills,
 * memories) links to the user's home so switching accounts changes only the paying
 * subscription, not settings or threads (probed on codex-cli 0.162.1: threads resume across
 * homes).
 *
 * Sillage stores no secrets itself: login uses the app-server launched in that home, with a
 * device code or API key; Codex writes and refreshes `auth.json`.
 */

export const codexAccountLabelSchema = z.string().trim().min(1).max(60)

export const codexAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** `pending` until a login succeeds in its home. */
  status: z.enum(['pending', 'ready']),
  /** Home authentication method as reported by Codex; null before login. */
  authMode: z.enum(['chatgpt', 'apiKey']).nullable(),
  /** Email and plan read after ChatGPT login; null for API keys. */
  email: z.string().nullable(),
  planType: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type CodexAccount = z.infer<typeof codexAccountSchema>

export const createCodexAccountBodySchema = z.object({ label: codexAccountLabelSchema })
export const updateCodexAccountBodySchema = z.object({ label: codexAccountLabelSchema })

/**
 * Two ways to authenticate a home: device code for a ChatGPT subscription without a browser on
 * the server, or API key. The standard browser flow is excluded: its callback targets the
 * server's `localhost:1455`, unreachable from the user's browser.
 */
export const startCodexLoginBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('deviceCode') }),
  z.object({ type: z.literal('apiKey'), apiKey: z.string().trim().min(1) }),
])

/**
 * Account login progress. `pending` carries the user's next steps: open the URL and enter the
 * code. `failed` retains Codex's reason.
 */
export interface CodexLoginStatusDto {
  state: 'idle' | 'pending' | 'done' | 'failed'
  verificationUrl: string | null
  userCode: string | null
  error: string | null
}

export interface CodexAccountListDto {
  accounts: CodexAccount[]
}
