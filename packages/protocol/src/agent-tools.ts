import { z } from 'zod'

/**
 * Optional tool families Sillage hands to agents, on top of what each CLI ships.
 *
 * A family is a user-facing switch, not a tool list. Disabled families are absent from the session
 * entirely: their tools leave the `sillage` server's list, the guidance that names them leaves the
 * startup context, and “Browser” adds no server and launches nothing. Codex, OpenCode, Grok and
 * Antigravity load every MCP tool description into context (about 12k tokens for the whole
 * `sillage` server, measured 25 Nov 2026), so trimming families shortens every one of their
 * sessions; Claude Code loads MCP tools on demand.
 */
export const AGENT_TOOL_FAMILIES = [
  'history',
  'board',
  'coordination',
  'automations',
  'worktrees',
  'actions',
  'instructions',
  'project',
  'browser',
] as const
export type AgentToolFamily = (typeof AGENT_TOOL_FAMILIES)[number]

/**
 * Instance defaults when the administrator has not chosen. Built-in tools start on, as before
 * families existed. The browser starts off: it downloads a browser engine and runs heavy
 * processes, which an instance should opt into.
 */
export const AGENT_TOOL_DEFAULTS: Record<AgentToolFamily, boolean> = {
  history: true,
  board: true,
  coordination: true,
  automations: true,
  worktrees: true,
  actions: true,
  instructions: true,
  project: true,
  browser: false,
}

/**
 * `sillage` server tools of each family. Every tool of `apps/server/src/mcp/sillage-mcp.mjs` is in
 * exactly one family or in `ALWAYS_ON_SILLAGE_TOOLS` (`test/mcp-parity.test.ts`). The daemon turns
 * disabled families into a tool list for the server (`SILLAGE_MCP_TOOLS_OFF`), so the server, out
 * of the module graph, needs no copy of this table.
 */
export const SILLAGE_TOOL_FAMILIES: Record<Exclude<AgentToolFamily, 'browser'>, readonly string[]> = {
  history: ['search_history', 'read_conversation', 'list_sessions', 'work_log', 'find_file_edits'],
  board: ['list_cards', 'read_card', 'add_card_note', 'move_card', 'update_card', 'create_card', 'link_cards', 'unlink_cards', 'attach_card', 'detach_card', 'update_issue'],
  coordination: ['start_session', 'list_models', 'send_session_message', 'broadcast_session_message', 'notify_when_done', 'read_session_messages', 'count_active_sessions', 'move_session',
    'read_session', 'wait_for_session', 'message_session', 'steer_session', 'interrupt_session', 'reply_session'],
  automations: ['schedule_task', 'create_automation'],
  worktrees: ['create_worktree', 'list_worktrees', 'remove_worktree'],
  actions: ['list_actions', 'register_action', 'remove_action', 'run_action'],
  instructions: ['read_instructions', 'edit_instructions', 'write_instructions'],
  project: ['set_project_image', 'attach_project_folder', 'list_project_folders', 'list_mcp_servers', 'install_mcp_server'],
}

/**
 * Never switched off: the session title and its dev servers' thread cards, project discovery, memory (how CLIs other than Claude
 * write it), decisions (already opted into per automation), and personal discussions' own tools.
 */
export const ALWAYS_ON_SILLAGE_TOOLS: readonly string[] = [
  'rename_session', 'describe_preview', 'list_projects', 'read_memory', 'write_memory', 'delete_memory', 'request_decision', 'withdraw_decision',
  'create_project', 'continue_in_project', 'delete_project', 'find_files',
]

/** Tool names the `sillage` server must hide for these effective families. */
export function disabledSillageTools(families: Record<AgentToolFamily, boolean>): string[] {
  return Object.entries(SILLAGE_TOOL_FAMILIES).flatMap(([family, tools]) => (families[family as AgentToolFamily] ? [] : tools))
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
