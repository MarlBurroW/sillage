import { z } from 'zod'
import { agentKindSchema } from './events.js'

/**
 * Account usage as reported by the CLI.
 *
 * Deliberately a **list** of windows rather than named fields: CLIs regularly add them
 * server-side without client updates. Fable's release introduced a dedicated window overnight;
 * the installed CLI probe now shows about a dozen keys, mostly still null and using codenames.
 * A fixed list would require rebuilding for every addition and silently hide anything
 * unanticipated.
 */

export const usageWindowSchema = z.object({
  /** Stable original CLI key, used as rendering identity. */
  id: z.string(),
  label: z.string(),
  /** Consumed fraction from 0 to 1; null if unreported. */
  utilization: z.number().nullable(),
  /** Window end in milliseconds; null if unknown. */
  resetsAt: z.number().nullable(),
})
export type UsageWindow = z.infer<typeof usageWindowSchema>

/**
 * Credits billed beyond the plan. CLIs report different data: Claude a percentage and amounts,
 * Codex a balance. `detail` is therefore preformatted text rather than a nonexistent shared
 * monetary model.
 */
export const usageCreditsSchema = z.object({
  label: z.string(),
  utilization: z.number().nullable(),
  detail: z.string().nullable(),
  enabled: z.boolean(),
})

/**
 * Free quota resets the account was granted (Codex), each lifting every usage window at once.
 * They expire, so the soonest expiry is what the user needs to know.
 */
export const usageResetCreditsSchema = z.object({
  available: z.number(),
  /** Soonest expiry among the listed credits, in milliseconds; null when none expires or unknown. */
  nextExpiresAt: z.number().nullable(),
  /** The backend's wording for the credit ("Full reset"), when given. */
  title: z.string().nullable(),
  description: z.string().nullable(),
})
export type UsageResetCredits = z.infer<typeof usageResetCreditsSchema>

/** What redeeming one reset did, in Codex's terms. */
export const usageResetOutcomeSchema = z.enum(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'])
export type UsageResetOutcome = z.infer<typeof usageResetOutcomeSchema>

export const agentUsageSchema = z.object({
  agent: agentKindSchema,
  /** CLI-reported plan (`max`, `plus`, etc.); null for usage billing. */
  plan: z.string().nullable(),
  /**
   * False when plan limits do not apply: API key, Bedrock, Vertex. Windows are then empty; this
   * is not a failure.
   */
  limitsAvailable: z.boolean(),
  windows: z.array(usageWindowSchema),
  credits: usageCreditsSchema.nullable(),
  /** Absent for CLIs without the concept; null when the account reports none. */
  resetCredits: usageResetCreditsSchema.nullable().optional(),
  fetchedAt: z.number(),
})
export type AgentUsage = z.infer<typeof agentUsageSchema>
