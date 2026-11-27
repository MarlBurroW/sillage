import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CopilotConfig } from '@sillage/protocol'

/** How Sillage launches `copilot --acp` and its environment. All claims probed on GitHub Copilot CLI 1.0.116. */

/**
 * Sillage chooses CLI versions itself (Settings › CLI versions), so the CLI must neither download
 * a newer build nor run one it cached earlier; `--no-auto-update` alone still lets plugin updates
 * run. Plugins come only from `--plugin-dir`: a user's installed plugins would bring MCP servers
 * and hooks Sillage does not show.
 */
export const COPILOT_ISOLATION_ENV: Record<string, string> = {
  COPILOT_AUTO_UPDATE: 'false',
  COPILOT_PLUGIN_DIR_ONLY: 'true',
  COPILOT_DISABLE_DESKTOP_NOTIFICATIONS: '1',
}

/** Key of Copilot's extensions in ACP `_meta`, and prefix of its extension methods. */
export const COPILOT_META = 'github.com/copilot'
/** Notification carrying a subscribed session event: `{sessionId, type, data, agentId?}`. */
export const COPILOT_EVENT_METHOD = `${COPILOT_META}/sessionEvent`

/**
 * Session events Sillage subscribes to at `initialize` (`copilot help acp`). Plain ACP leaves out
 * what they carry: the native tool name and the MCP identity of a call (`assistant.message`),
 * which tool call spawned a sub-agent (`assistant.turn_start`), per-call usage and quota, errors
 * and retries as data rather than as "Error: …" text, compaction, MCP server health, and the end
 * of a turn Copilot started by itself when background work finished (`session.idle`).
 * `tool.execution_*` and `subagent.*` are not relayed even when asked for (1.0.116).
 */
export const COPILOT_SESSION_EVENTS = [
  'assistant.turn_start', 'assistant.message', 'assistant.usage', 'assistant.turn_retry',
  'session.idle', 'session.info', 'session.warning', 'session.error',
  'session.compaction_start', 'session.compaction_complete',
  'session.mcp_server_status_changed', 'session.mcp_servers_loaded', 'session.mcp_server_tools_loaded',
] as const

/**
 * Announced on top of the shared ACP handshake. `elicitation.form` is what makes Copilot offer
 * its `ask_user` tool at all; naming the client (`clientInfo`) already marks the session as driven
 * by a person.
 */
export const COPILOT_CLIENT_CAPABILITIES: Record<string, unknown> = {
  elicitation: { form: {} },
  _meta: { [COPILOT_META]: { events: [...COPILOT_SESSION_EVENTS] } },
}

/**
 * Copilot refuses to open a session without a sign-in and only answers "Authentication
 * required": say what to do instead. Any other failure passes through.
 */
export function explainSignIn(error: unknown): unknown {
  return error instanceof Error && /authentication required/i.test(error.message)
    ? new Error('GitHub Copilot is not signed in on this machine. Run `copilot login` in a terminal there, or give the server a token in COPILOT_GITHUB_TOKEN.')
    : error
}

/** Routing profiles documented by `copilot help config` for `autoTier`; the server may advertise others. */
export const COPILOT_AUTO_TIERS = ['efficiency', 'balance', 'intelligence'] as const

/** Model ID Copilot uses for its router: `--model auto`, stored as `auto`. */
export const COPILOT_AUTO_MODEL = 'auto'

export interface CopilotLaunchInput {
  /** Sillage skill library roots; each holds `skills/<name>/SKILL.md`. */
  skillRoots: string[]
  /** Directories outside cwd the agent may read and write without a path prompt. */
  directories: string[]
  /** Directory holding `.github/instructions/sillage.instructions.md`, null without an overview. */
  instructionsDir: string | null
}

/** Launch-time choices requiring a process restart when changed. */
export interface CopilotLaunch {
  args: string[]
  env: Record<string, string>
}

/**
 * Skills are passed one directory at a time: `--plugin-dir` accepts a folder with a SKILL.md and
 * names its command after the skill, whereas a library root would need a `plugin.json` and would
 * prefix every command (`/sillage:name`).
 */
export function skillDirs(roots: string[]): string[] {
  return roots.flatMap((root) => {
    const dir = join(root, 'skills')
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(dir, entry.name, 'SKILL.md')))
      .map((entry) => join(dir, entry.name))
  })
}

export function copilotLaunch(config: CopilotConfig, input: CopilotLaunchInput): CopilotLaunch {
  const args = ['--acp', '--no-auto-update', '--disable-client-telemetry']
  // ACP has no option for the Auto routing profile: it is read at launch only.
  if (config.autoTier && (config.model === COPILOT_AUTO_MODEL || !config.model)) args.push('--auto-tier', config.autoTier)
  for (const dir of [...new Set(input.directories)]) args.push('--add-dir', dir)
  for (const dir of skillDirs(input.skillRoots)) args.push('--plugin-dir', dir)
  const env: Record<string, string> = { ...COPILOT_ISOLATION_ENV }
  // Read on every launch, so a resumed session gets the current SILLAGE.md too.
  if (input.instructionsDir) env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = input.instructionsDir
  return { args, env }
}

/** Launch of a process that only reads Copilot's state (catalog, native sessions): no skills, directories or instructions. */
export function copilotProbeLaunch(): CopilotLaunch {
  return copilotLaunch(
    { agent: 'copilot', model: '', reasoningEffort: '', autoTier: '', mode: 'agent', allowAll: 'off', additionalDirectories: [], mcpServers: [], sillageMcp: false, skillLibrary: false },
    { skillRoots: [], directories: [], instructionsDir: null },
  )
}

export function sameLaunch(a: CopilotLaunch, b: CopilotLaunch): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `instructions.md` files apply to every path only with an `applyTo` glob. */
export function instructionsFile(overview: string): string {
  return `---\napplyTo: "**"\n---\n${overview}\n`
}

/** ACP `mode` values are URLs ending with the mode name. */
const MODE_PREFIX = 'https://agentclientprotocol.com/protocol/session-modes#'
export function modeValue(mode: CopilotConfig['mode']): string {
  return MODE_PREFIX + mode
}
export function modeOf(value: unknown): CopilotConfig['mode'] | null {
  if (typeof value !== 'string') return null
  const name = value.startsWith(MODE_PREFIX) ? value.slice(MODE_PREFIX.length) : value
  return name === 'agent' || name === 'plan' || name === 'autopilot' ? name : null
}
