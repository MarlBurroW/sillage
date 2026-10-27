import { z } from 'zod'

/**
 * Additional Claude accounts per user.
 *
 * The CLI has one login per configuration directory, managed by `/login`. To support several
 * without duplicating settings, transcripts and memory, Sillage stores a secret per account and
 * passes it in the session environment: a long-lived OAuth token from `claude setup-token` in
 * `CLAUDE_CODE_OAUTH_TOKEN` (subscription), or a Console API key in `ANTHROPIC_API_KEY` (usage
 * billing). Both override the saved CLI login (probed on 2.1.296).
 *
 * Like git credentials, secrets are write-only through the API and belong to a Sillage account
 * rather than the instance: they represent someone's subscription.
 */

export const claudeAccountKindSchema = z.enum(['oauth', 'apiKey'])
export type ClaudeAccountKind = z.infer<typeof claudeAccountKindSchema>

export const claudeAccountSchema = z.object({
  id: z.string(),
  /** User-chosen label (“Personal”, “Work”): the token does not identify its owner. */
  label: z.string(),
  /**
   * `oauth` accounts have a usage gauge, read with their own token; API keys have no plan.
   */
  kind: claudeAccountKindSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ClaudeAccount = z.infer<typeof claudeAccountSchema>

export const claudeAccountLabelSchema = z.string().trim().min(1).max(60)

/**
 * Output from `claude setup-token` (`sk-ant-oat01-…`) or a Console API key (`sk-ant-api03-…`).
 * The prefix is the only check possible without spending a turn: the CLI cannot say anything
 * about a secret until a request presents it.
 */
export const claudeSecretSchema = z
  .string()
  .trim()
  .regex(
    /^sk-ant-(oat01|api\d{2})-[A-Za-z0-9_-]{20,}$/,
    'Un jeton de `claude setup-token` (sk-ant-oat01-…) ou une clé API (sk-ant-api03-…).',
  )

/** A secret's kind is identified by its prefix. */
export function claudeSecretKind(secret: string): ClaudeAccountKind {
  return secret.startsWith('sk-ant-oat01-') ? 'oauth' : 'apiKey'
}

export const createClaudeAccountBodySchema = z.object({
  label: claudeAccountLabelSchema,
  token: claudeSecretSchema,
})

/** Rename, replace an expired secret, or both: every field is optional. */
export const updateClaudeAccountBodySchema = z
  .object({
    label: claudeAccountLabelSchema.optional(),
    token: claudeSecretSchema.optional(),
  })
  .refine((body) => body.label !== undefined || body.token !== undefined, {
    message: 'Rien à modifier.',
  })

export interface ClaudeAccountListDto {
  accounts: ClaudeAccount[]
}

/**
 * Guided subscription login: Sillage runs `claude setup-token` in a pseudoterminal, shows the
 * authorization URL, accepts the code displayed by the page and captures the printed token. The
 * account is created only at completion, with that token, which also reads its usage gauge.
 */
export const startClaudeLoginBodySchema = z.object({ label: claudeAccountLabelSchema })

export const submitClaudeLoginCodeBodySchema = z.object({ code: z.string().trim().min(1).max(400) })

export interface ClaudeLoginStatusDto {
  loginId: string
  /**
   * `starting` until the CLI prints its URL; `waiting_code` while awaiting a code; `checking`
   * during verification; `done` with the created account; `failed` with a reason. Codes can be
   * resubmitted while the CLI remains alive.
   */
  state: 'starting' | 'waiting_code' | 'checking' | 'done' | 'failed'
  authUrl: string | null
  error: string | null
  account: ClaudeAccount | null
}
