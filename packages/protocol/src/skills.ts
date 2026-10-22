import { z } from 'zod'

/**
 * Skills a CLI makes available to the session.
 *
 * Codex publishes them through `skills/list` and references them as `$name`. These are not
 * commands: nothing executes client-side. Skills join the message as first-class inputs
 * (`{type:'skill'}`), like file mentions. Claude exposes skills among slash commands and
 * publishes nothing here.
 */
export const agentSkillSchema = z.object({
  /** Without `$`, as named by the CLI; the only resolution key on send. */
  name: z.string(),
  description: z.string(),
})

export type AgentSkillDto = z.infer<typeof agentSkillSchema>

/**
 * Maximum skills per message, matching the mention limit for the same reason: each injects a
 * whole document into context.
 */
export const MAX_SKILLS_PER_MESSAGE = 20
