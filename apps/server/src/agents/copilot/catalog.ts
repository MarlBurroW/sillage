import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentModelDto, AgentModelsDto, SlashCommandDto } from '@sillage/protocol'
import { AcpClient } from '../acp/client.js'
import { fields } from '../acp/content.js'
import { toSlashCommands } from '../acp/commands.js'
import { CachedProbeMap } from '../cached-probe.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { COPILOT_AUTO_MODEL, copilotProbeLaunch, copilotProcessEnv, explainSignIn } from './launch.js'

/**
 * Copilot's models follow the signed-in plan (a Free plan lists only Auto) and arrive only with a
 * session: `initialize` carries none. A session that never receives a prompt is not listed by
 * `session/list` (probed on 1.0.116), so a disposable one is safe to open.
 */

const TTL_MS = 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 60_000
/** Copilot announces its commands just after answering `session/new`. */
const COMMANDS_WAIT_MS = 3_000

/**
 * Commands that would move the session somewhere Sillage does not track: another working
 * directory, extra directories outside the conversation's settings, or another native session
 * (`/session delete` replaces the current one). `/allow-all`, `/permissions`, `/autopilot` and
 * `/plan` stay: Copilot announces what they change, and the conversation's settings follow.
 */
const UNTRACKED_COMMANDS = new Set(['cwd', 'add-dir', 'session'])

export function copilotCommands(listed: unknown): SlashCommandDto[] {
  return toSlashCommands(listed).filter((command) => !UNTRACKED_COMMANDS.has(command.name))
}

export interface CopilotListing { models: AgentModelsDto; commands: SlashCommandDto[] }

export function optionsOf(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const option = fields(item)
    return Array.isArray(option.options) ? optionsOf(option.options) : [option]
  })
}

export function configOption(state: unknown, id: string): Record<string, unknown> {
  const options = fields(state).configOptions
  return (Array.isArray(options) ? options.map(fields) : []).find((option) => option.id === id) ?? {}
}

/** Copilot 1.0.116 advertises no effort option on Auto; ACP names the category `thought_level`. */
export function effortOption(state: unknown): Record<string, unknown> {
  const options = fields(state).configOptions
  return (Array.isArray(options) ? options.map(fields) : []).find((option) =>
    option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort') ?? {}
}

/**
 * Models of one session state. Copilot lists Auto twice (a description entry, then one with its
 * premium multiplier in `_meta.copilotUsage`): one row each, merging what both say.
 */
export function modelCatalog(state: unknown): AgentModelDto[] {
  const model = configOption(state, 'model')
  const effort = effortOption(state)
  const byValue = new Map<string, AgentModelDto>()
  for (const entry of optionsOf(model.options)) {
    if (typeof entry.value !== 'string') continue
    const usage = fields(entry._meta).copilotUsage
    const known = byValue.get(entry.value)
    if (known) {
      if (typeof usage === 'string' && !known.hint?.includes(usage)) known.hint = `${entry.value} · ${usage}`
      continue
    }
    const current = entry.value === model.currentValue
    byValue.set(entry.value, {
      value: entry.value,
      displayName: String(entry.name ?? entry.value),
      description: String(entry.description ?? ''),
      hint: typeof usage === 'string' ? `${entry.value} · ${usage}` : entry.value,
      isDefault: current,
      efforts: current ? optionsOf(effort.options).map((level) => ({ value: String(level.value), label: String(level.name ?? level.value), hint: typeof level.description === 'string' ? level.description : null })) : [],
      defaultEffort: current && typeof effort.currentValue === 'string' ? effort.currentValue : null,
      supportsFastMode: false,
    })
  }
  // Auto leads its list, as in OpenCode's GitHub Copilot section: it is a way of choosing.
  return [...byValue.values()].sort((a, b) => Number(b.value === COPILOT_AUTO_MODEL) - Number(a.value === COPILOT_AUTO_MODEL))
}

/**
 * `session/new` leaves a folder in Copilot's home even for a session that never receives a
 * prompt, and `session/close` keeps it (observed on 1.0.116): unlisted, but one more per catalog
 * read. The probe removes its own, and only its own: a session with an event log is someone's.
 */
export function forgetProbeSession(sessionId: unknown, home = process.env.COPILOT_HOME || join(homedir(), '.copilot')): void {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId)) return
  const dir = join(home, 'session-state', sessionId)
  if (!existsSync(dir) || existsSync(join(dir, 'events.jsonl'))) return
  rmSync(dir, { recursive: true, force: true })
}

/** Models follow the plan: extra accounts probe inside their own `COPILOT_HOME`, one cache entry per home (empty for the machine's sign-in). */
export class CopilotCatalog {
  private readonly probes = new CachedProbeMap<CopilotListing>(TTL_MS, (home) => this.read(home || undefined))

  /** `cwd` is an empty folder of Sillage's own: the user's home would make Copilot index it and read its AGENTS.md. */
  constructor(private readonly executable: () => Promise<string>, private readonly cwd: string) {}

  invalidate(): void { this.probes.invalidate() }

  list(force = false, home?: string): Promise<CopilotListing & { fetchedAt: number }> {
    return this.probes.read(home ?? '', force)
  }

  private async read(home?: string): Promise<CopilotListing> {
    const cwd = this.cwd
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    let commands: SlashCommandDto[] | null = null
    let announced: () => void = () => {}
    const commandsSeen = new Promise<void>((resolve) => { announced = resolve })
    const launch = copilotProbeLaunch(home)
    const client = new AcpClient({
      label: 'copilot-catalog', binary: await this.executable(), args: launch.args, cwd,
      env: copilotProcessEnv(launch.env), onStderr: () => {},
      onNotification: (method, params) => {
        const update = fields(fields(params).update)
        if (method === 'session/update' && update.sessionUpdate === 'available_commands_update') { commands = copilotCommands(update.availableCommands); announced() }
      },
    })
    const timeout = setTimeout(() => client.close(), PROBE_TIMEOUT_MS)
    let opened: unknown = null
    try {
      await client.initialize(CLIENT_INFO)
      // The models follow the plan: without a sign-in there is no catalog, and the composer says why.
      const session = await client.request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] }, PROBE_TIMEOUT_MS).catch((error: unknown) => { throw explainSignIn(error, Boolean(home)) })
      opened = session.sessionId
      const models = modelCatalog(session)
      // Efforts are per model and only advertised for the selected one.
      for (const model of models) {
        if (model.isDefault) continue
        const state = await client.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: model.value }).catch(() => null)
        const current = state ? modelCatalog(state).find((entry) => entry.isDefault) : undefined
        if (current) { model.efforts = current.efforts; model.defaultEffort = current.defaultEffort }
      }
      if (commands === null) await Promise.race([commandsSeen, new Promise((resolve) => setTimeout(resolve, COMMANDS_WAIT_MS))])
      return { models: { models, modes: [], account: null, outputStyles: [], fastMode: null, agents: [], fetchedAt: Date.now() }, commands: commands ?? [] }
    } finally {
      clearTimeout(timeout)
      await client.closeAndWait()
      forgetProbeSession(opened, home)
    }
  }
}
