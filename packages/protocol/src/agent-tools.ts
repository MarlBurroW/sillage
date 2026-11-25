import { z } from 'zod'

/**
 * Optional tool families Sillage hands to agents, on top of what each CLI ships.
 *
 * A family is a user-facing switch, not a tool list: “Browser” covers a whole MCP server and the
 * browsers the daemon runs for it. Disabled families are absent from the session entirely (no
 * server, no tool descriptions, nothing installed or launched), so they cost neither tokens nor
 * machine resources. More families (the built-in MCP server's groups) join this list later, see
 * card #114.
 */
export const AGENT_TOOL_FAMILIES = ['browser'] as const
export type AgentToolFamily = (typeof AGENT_TOOL_FAMILIES)[number]

/**
 * Instance defaults when the administrator has not chosen. The browser starts off: it downloads a
 * browser engine and runs heavy processes, which an instance should opt into.
 */
export const AGENT_TOOL_DEFAULTS: Record<AgentToolFamily, boolean> = {
  browser: false,
}

/** Explicit choices only: an absent family follows the level above. */
export type AgentToolSettings = Partial<Record<AgentToolFamily, boolean>>

/** Strict so a typo in a family name is refused instead of silently ignored. */
export const agentToolSettingsSchema = z
  .object(Object.fromEntries(AGENT_TOOL_FAMILIES.map((family) => [family, z.boolean().optional()])) as Record<AgentToolFamily, z.ZodOptional<z.ZodBoolean>>)
  .strict()

/**
 * Project override: `null` for a family returns it to the instance default. Same scope rule as
 * every inherited setting: global belongs to the admin, the project part to the project owner.
 */
export const agentToolOverridesSchema = z
  .object(Object.fromEntries(AGENT_TOOL_FAMILIES.map((family) => [family, z.boolean().nullable().optional()])) as Record<AgentToolFamily, z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>)
  .strict()
export type AgentToolOverrides = z.infer<typeof agentToolOverridesSchema>

/** Keeps known families with boolean values; anything else in stored JSON is dropped. */
export function sanitizeAgentToolSettings(value: unknown): AgentToolSettings {
  if (!value || typeof value !== 'object') return {}
  const out: AgentToolSettings = {}
  for (const family of AGENT_TOOL_FAMILIES) {
    const choice = (value as Record<string, unknown>)[family]
    if (typeof choice === 'boolean') out[family] = choice
  }
  return out
}

/** Applies a project patch: `null` clears the override, `undefined` keeps it. */
export function applyAgentToolOverrides(current: AgentToolSettings, patch: AgentToolOverrides): AgentToolSettings {
  const next: AgentToolSettings = { ...current }
  for (const family of AGENT_TOOL_FAMILIES) {
    const choice = patch[family]
    if (choice === null) delete next[family]
    else if (choice !== undefined) next[family] = choice
  }
  return next
}

/** Effective families for a session: project choice, else instance choice, else the default. */
export function resolveAgentTools(
  instance: AgentToolSettings,
  project: AgentToolSettings | null,
): Record<AgentToolFamily, boolean> {
  return Object.fromEntries(
    AGENT_TOOL_FAMILIES.map((family) => [family, project?.[family] ?? instance[family] ?? AGENT_TOOL_DEFAULTS[family]]),
  ) as Record<AgentToolFamily, boolean>
}
