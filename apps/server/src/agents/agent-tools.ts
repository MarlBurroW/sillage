import { eq } from 'drizzle-orm'
import { cardIssues, projects, type Db } from '@sillage/db'
import {
  AGENT_TOOL_DEFAULTS,
  AGENT_TOOL_FAMILIES,
  SILLAGE_TOOL_FAMILIES,
  resolveAgentTools,
  sanitizeAgentToolSettings,
  type AgentToolFamily,
  type AgentToolSettings,
} from '@sillage/protocol'
import type { Config } from '../config.js'
import { readAppSettings } from '../settings/app-settings.js'

/** Must match `TOOL_FAMILY_OFF` in `apps/server/src/mcp/sillage-mcp.mjs`. */
export const TOOL_FAMILY_OFF = "This Sillage tool is turned off for this project. The project owner can turn its family back on from the project page, Agents tab, “Agent tools” (French interface: onglet « Agents », « Outils des agents »); an administrator sets the default under Settings › Agent tools. Tell the user about this setting instead of working around it."

/** Stored project JSON, tolerant of hand edits like every other settings reader. */
export function readProjectAgentTools(raw: string | null | undefined): AgentToolSettings {
  if (!raw) return {}
  try {
    return sanitizeAgentToolSettings(JSON.parse(raw))
  } catch {
    return {}
  }
}

/**
 * Families a session launching now receives. Read at each launch rather than cached: a switch
 * applies to the next runner start, the same moment MCP servers are resolved. Personal
 * discussions (no project) follow the instance defaults.
 */
export function agentToolsFor(db: Db, config: Config, projectId: string | null): Record<AgentToolFamily, boolean> {
  const instance = readAppSettings(db, config).agentTools
  const project = projectId === null
    ? null
    : readProjectAgentTools(db.select({ agentTools: projects.agentTools }).from(projects).where(eq(projects.id, projectId)).get()?.agentTools)
  return resolveAgentTools(instance, project)
}

export type Families = Record<AgentToolFamily, boolean>

/**
 * Built-in families of one launching session, computed once per launch and handed to everything
 * that names tools (MCP list, startup context, live context). Null for a personal discussion: it
 * is the account's assistant, outside any project's switches, and keeps its tools.
 *
 * A GitHub maintenance session answers its issue through board tools (`add_card_note` with
 * `github: true`, `update_issue`); without them it would publish through `gh`, maybe without the
 * session marker, and start another session. Its board stays on whatever the project chose.
 */
export function sessionFamilies(db: Db, conversation: { id: string; projectId: string | null }, families: Families): Families | null {
  if (conversation.projectId === null) return null
  const maintenance = db.select({ id: cardIssues.responderId }).from(cardIssues).where(eq(cardIssues.responderId, conversation.id)).get()
  return maintenance ? { ...families, board: true } : families
}

/** Human names for the live notice, in English like all model-facing text. */
const FAMILY_NAMES: Record<Exclude<AgentToolFamily, 'browser'>, string> = {
  history: 'History and sessions',
  board: 'Board',
  coordination: 'Coordination',
  automations: 'Schedules and automations',
  worktrees: 'Worktrees',
  actions: 'Project actions',
  instructions: 'Instructions',
  project: 'Project setup',
}

/**
 * Sent with the first message of every launch (never frozen, unlike Claude's or Grok's first
 * system prompt), so it outranks any older text that still names these tools: a resumed system
 * prompt, a CLI handoff, a moved session's summary, a scheduled run's header.
 */
export function disabledFamiliesNotice(families: Families | null): string | null {
  if (!families) return null
  const off = AGENT_TOOL_FAMILIES.filter((family): family is Exclude<AgentToolFamily, 'browser'> => family !== 'browser' && !families[family])
  if (off.length === 0) return null
  const list = off.map((family) => `${FAMILY_NAMES[family]} (${SILLAGE_TOOL_FAMILIES[family].map((tool) => `\`${tool}\``).join(', ')})`).join('; ')
  return `In this project, these Sillage tool families are turned off: ${list}. These tools are unavailable even where earlier instructions or context mention them; do not try to call them. If the user needs one, tell them the project owner can turn its family on in the project's Agents tab.`
}

/** Defaults and the tool table, for the MCP server to judge another project's switches (cross-project calls). */
export function familyTableForMcp(): string {
  return JSON.stringify({ defaults: AGENT_TOOL_DEFAULTS, tools: SILLAGE_TOOL_FAMILIES })
}
