import { z } from 'zod'
import {
  agentConfigSchema,
  claudeConfigSchema,
  codexConfigSchema,
  opencodeConfigSchema,
  grokConfigSchema,
  type ClaudeConfig,
  type CodexConfig,
  type OpencodeConfig,
  type GrokConfig,
} from './agent-config.js'

/**
 * Project presets: initial conversation settings before account defaults.
 *
 * Shared rather than personal, unlike `AgentDefaults`: they describe the project, not its
 * reader. MCP servers useful to a repository are useful to everyone, and additional
 * directories, excluded from account defaults because they name specific folders, belong here.
 * Only the project owner can write them.
 *
 * One preset per CLI, as for accounts and for the same reason: Claude and Codex safeguards do
 * not map onto each other. `null` means “this project says nothing about this CLI”, leaving
 * account defaults in control; it differs from an empty preset.
 */
export interface ProjectAgentDefaults {
  claude: ClaudeConfig | null
  codex: CodexConfig | null
  opencode: OpencodeConfig | null
  grok: GrokConfig | null
}

export const NO_PROJECT_DEFAULTS: ProjectAgentDefaults = {
  claude: null,
  codex: null,
  opencode: null,
  grok: null,
}

/**
 * Tolerant like account settings: CLI configurations that drifted from the protocol fall back
 * to “unspecified” rather than making the project unreadable.
 */
export const projectAgentDefaultsSchema = z
  .object({
    claude: claudeConfigSchema.nullable().default(null).catch(null),
    codex: codexConfigSchema.nullable().default(null).catch(null),
    opencode: opencodeConfigSchema.nullable().default(null).catch(null),
    grok: grokConfigSchema.nullable().default(null).catch(null),
  })
  .catch(NO_PROJECT_DEFAULTS)

/**
 * Reads `projects.default_config`.
 *
 * The previous format may still exist: one configuration without a CLI key. Store it under the
 * CLI named by its discriminant rather than silently losing it on first read.
 */
export function readProjectDefaults(raw: string | null | undefined): ProjectAgentDefaults {
  if (!raw) return NO_PROJECT_DEFAULTS

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NO_PROJECT_DEFAULTS
  }

  const legacy = agentConfigSchema.safeParse(parsed)
  if (legacy.success) return { ...NO_PROJECT_DEFAULTS, [legacy.data.agent]: legacy.data }

  return projectAgentDefaultsSchema.parse(parsed)
}

/**
 * Column value for a replaced preset.
 *
 * `null` when no CLI has a preset: restores the new-project state, with no distinction between
 * “cleared” and “never configured”.
 */
export function serializeProjectDefaults(defaults: ProjectAgentDefaults): string | null {
  if (!defaults.claude && !defaults.codex && !defaults.opencode && !defaults.grok) return null
  return JSON.stringify(defaults)
}
