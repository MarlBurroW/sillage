import { z } from 'zod'

/**
 * Additional GitHub Copilot CLI accounts per user.
 *
 * Copilot keeps its sign-in per `COPILOT_HOME`, in `config.json` (or the system keychain, keyed
 * by the login `config.json` names). Each additional account gets its own home where only that
 * file, the settings that allow storing the token, and logs are real. Sessions, MCP servers,
 * instructions, agents and skills link to the user's home, so switching accounts changes only
 * which plan pays, and a conversation resumes whichever account opened it.
 *
 * Sillage stores no secret: Copilot signs in through the device code flow in that home
 * (`copilot login --device-code`) and writes the token itself.
 */

export const copilotAccountLabelSchema = z.string().trim().min(1).max(60)

export const copilotAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** `pending` until a sign-in succeeds in its home. */
  status: z.enum(['pending', 'ready']),
  /** GitHub login Copilot reported; null before the first sign-in. */
  login: z.string().nullable(),
  /** GitHub host of the login, `https://github.com` unless data residency. */
  host: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type CopilotAccount = z.infer<typeof copilotAccountSchema>

export const createCopilotAccountBodySchema = z.object({ label: copilotAccountLabelSchema })
export const updateCopilotAccountBodySchema = z.object({ label: copilotAccountLabelSchema })

/** Sign-in progress, with the same shape as Grok and Codex accounts. */
export interface CopilotLoginStatusDto {
  state: 'idle' | 'pending' | 'done' | 'failed'
  verificationUrl: string | null
  userCode: string | null
  error: string | null
}

export interface CopilotAccountListDto {
  accounts: CopilotAccount[]
}
