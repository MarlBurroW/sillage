import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CopilotConfig, McpServer } from '@sillage/protocol'
import { agentProcessEnv } from '../process-env.js'

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

/** Tokens Copilot takes ahead of any stored sign-in, in this order (`copilot help environment`). */
const TOKEN_VARIABLES = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']

/**
 * Environment of a Copilot process. `COPILOT_HOME` among the overrides is an extra account's
 * home: the server's tokens are then removed, since any of them would silently answer in that
 * account's place, and a `GH_TOKEN` set for the GitHub CLI would decide which plan pays. The
 * agent's own shell commands lose them too in that session.
 */
export function copilotProcessEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = agentProcessEnv(overrides)
  if (overrides.COPILOT_HOME) for (const name of TOKEN_VARIABLES) delete env[name]
  // Must stay unset for `escapeDollars` to produce a literal dollar sign.
  delete env[UNSET_VARIABLE]
  return env
}

/**
 * Copilot expands `$NAME`, `${NAME}` and `${NAME:-default}` in every string of an MCP config file
 * (command, args, env, url, headers) when NAME is set, and has no escape: `$$` and `\$` expand
 * too. A default is taken literally and in one pass, so `${unset:-$}` is the only way to write a
 * dollar sign (probed on 1.0.116). Servers passed over ACP are not expanded.
 */
const UNSET_VARIABLE = 'SILLAGE_UNSET_FOR_LITERAL_DOLLAR'
const LITERAL_DOLLAR = `\${${UNSET_VARIABLE}:-$}`
// A function, since a replacement string gives `$` sequences a meaning of their own.
const escapeDollars = (value: string) => value.replaceAll('$', () => LITERAL_DOLLAR)
const escapeMap = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([name, value]) => [name, escapeDollars(value)]))

/**
 * Contents of the `--additional-mcp-config` file holding Sillage's servers, null without any.
 * Servers passed in `session/new` share a namespace with `$COPILOT_HOME/mcp-config.json`, the
 * workspace's `.mcp.json` and plugins, and lose to a same-named server there without a word
 * (probed on 1.0.116 and 1.0.117): a user who added `sillage` to their terminal Copilot would
 * replace the session's own server. This channel is read last and wins. It holds secrets, so it
 * is a private file rather than an argument.
 */
export function copilotMcpConfig(servers: McpServer[]): string | null {
  if (!servers.length) return null
  const entries = servers.map(({ name, transport }) => [name, transport.type === 'stdio'
    ? { type: 'local', command: escapeDollars(transport.command), args: transport.args.map(escapeDollars), env: escapeMap(transport.env), tools: ['*'] }
    : { type: transport.type, url: escapeDollars(transport.url), headers: escapeMap(transport.headers), tools: ['*'] }])
  return JSON.stringify({ mcpServers: Object.fromEntries(entries) })
}

/** Key of Copilot's extensions in ACP `_meta`, and prefix of its extension methods. */
export const COPILOT_META = 'github.com/copilot'
/** Notification carrying a subscribed session event: `{sessionId, type, data, agentId?}`. */
export const COPILOT_EVENT_METHOD = `${COPILOT_META}/sessionEvent`

/**
 * Session events Sillage subscribes to at `initialize` (`copilot help acp`). Plain ACP leaves out
 * what they carry: the native tool name and the MCP identity of a call (`assistant.message`),
 * which tool call spawned a sub-agent and the model it runs (`assistant.turn_start`,
 * `subagent.started`), per-call usage and quota, errors and retries as data rather than as
 * "Error: …" text, compaction, MCP server health, the end of a turn Copilot started by itself
 * when background work finished (`session.idle`), the end of the reply while attached background
 * work keeps the prompt pending (`assistant.idle`), prompts scheduled with `/every` and `/after`
 * (`session.schedule_*`) and the message a schedule sends when it fires (`user.message`), the
 * skills Copilot actually loaded (`session.skills_loaded`), and the user's own hooks, which run
 * under ACP without asking (`hook.end`). All relayed on 1.0.116 and 1.0.117; `tool.execution_*`
 * is too, but `assistant.message` already names every call.
 */
export const COPILOT_SESSION_EVENTS = [
  'assistant.turn_start', 'assistant.message', 'assistant.usage', 'assistant.turn_retry',
  'assistant.idle', 'session.idle', 'session.info', 'session.warning', 'session.error',
  'session.compaction_start', 'session.compaction_complete',
  'session.mcp_server_status_changed', 'session.mcp_servers_loaded', 'session.mcp_server_tools_loaded',
  'session.schedule_created', 'session.schedule_cancelled', 'session.schedule_rearmed', 'user.message',
  'subagent.started', 'session.skills_loaded', 'hook.end',
] as const

/** Cadence of a schedule as `/every` writes it (`90s`, `1h30m`): Copilot gives milliseconds, not a cron expression. */
export function scheduleInterval(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  const parts: [number, string][] = [[Math.floor(seconds / 86_400), 'd'], [Math.floor(seconds % 86_400 / 3600), 'h'], [Math.floor(seconds % 3600 / 60), 'm'], [seconds % 60, 's']]
  return parts.filter(([count]) => count > 0).map(([count, unit]) => `${count}${unit}`).join('')
}

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
 * required": say what to do instead. Any other failure passes through. `account`: the process ran
 * on an extra account's home rather than the machine's sign-in.
 */
export function explainSignIn(error: unknown, account = false): unknown {
  if (!(error instanceof Error && /authentication required/i.test(error.message))) return error
  return new Error(account
    ? 'The GitHub Copilot account chosen for this conversation is no longer signed in. Sign it in again in Settings › Copilot accounts.'
    : 'GitHub Copilot is not signed in on this machine. Run `copilot login` in a terminal there, or give the server a token in COPILOT_GITHUB_TOKEN.')
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
  /** File written from `copilotMcpConfig`, null without servers. */
  mcpConfigFile?: string | null
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
  if (input.mcpConfigFile) args.push('--additional-mcp-config', `@${input.mcpConfigFile}`)
  const env: Record<string, string> = { ...COPILOT_ISOLATION_ENV }
  // Read on every launch, so a resumed session gets the current SILLAGE.md too.
  if (input.instructionsDir) env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = input.instructionsDir
  return { args, env }
}

/**
 * Launch of a process that only reads Copilot's state (catalog, native sessions): no skills,
 * directories or instructions. `home` is an extra account's `COPILOT_HOME`.
 */
export function copilotProbeLaunch(home?: string): CopilotLaunch {
  const launch = copilotLaunch(
    { agent: 'copilot', model: '', reasoningEffort: '', autoTier: '', mode: 'agent', allowAll: 'off', additionalDirectories: [], mcpServers: [], sillageMcp: false, skillLibrary: false, account: null },
    { skillRoots: [], directories: [], instructionsDir: null },
  )
  return home ? { ...launch, env: { ...launch.env, COPILOT_HOME: home } } : launch
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
