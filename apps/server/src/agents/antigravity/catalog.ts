import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentModelDto, AgentModelsDto, AgentUsage, SlashCommandDto } from '@sillage/protocol'
import { AcpClient } from '../acp/client.js'
import { fields } from '../acp/content.js'
import { toSlashCommands } from '../acp/commands.js'
import { CachedProbe } from '../cached-probe.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { antigravityEnv, userAntigravityHome } from '../../antigravity-accounts/homes.js'
import { antigravityArgs } from './launch.js'

function credentialRevision(home: string): string {
  return ['settings.json', '../sillage-credentials.json'].map((name) => {
    try { const file = statSync(join(home, 'antigravity-acp', name)); return `${file.mtimeMs}:${file.size}` } catch { return '' }
  }).join(':')
}

interface Listing { models: AgentModelsDto; commands: SlashCommandDto[] }
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
export function modelCatalog(state: unknown): AgentModelsDto {
  const model = configOption(state, 'model')
  const thinking = configOption(state, 'thinking_level')
  const models: AgentModelDto[] = optionsOf(model.options).map((entry) => ({
    value: String(entry.value), displayName: String(entry.name ?? entry.value), description: String(entry.description ?? ''),
    hint: String(entry.value), isDefault: entry.value === model.currentValue,
    efforts: entry.value === model.currentValue ? optionsOf(thinking.options).map((level) => ({ value: String(level.value), label: String(level.name ?? level.value), hint: typeof level.description === 'string' ? level.description : null })) : [],
    defaultEffort: entry.value === model.currentValue && typeof thinking.currentValue === 'string' ? thinking.currentValue : null,
    supportsFastMode: false,
  }))
  return { models, modes: [], account: null, outputStyles: [], fastMode: null, agents: [], fetchedAt: Date.now() }
}

export class AntigravityCatalog {
  private readonly catalogs = new Map<string, CachedProbe<Listing>>()
  private readonly quotas = new Map<string, CachedProbe<Omit<AgentUsage, 'fetchedAt'>>>()
  constructor(private readonly executable: () => Promise<string>) {}

  invalidate(): void {
    this.catalogs.clear()
    this.quotas.clear()
  }

  list(home = userAntigravityHome(), cwd = homedir(), force = false): Promise<Listing & { fetchedAt: number }> {
    for (const [key, probe] of this.catalogs) if (probe.expired(60 * 60_000)) this.catalogs.delete(key)
    const key = JSON.stringify([home, cwd, credentialRevision(home)])
    let probe = this.catalogs.get(key)
    if (!probe) {
      probe = new CachedProbe(60 * 60_000, () => this.probe(home, cwd, false).then((result) => result.listing))
      this.catalogs.set(key, probe)
    }
    return probe.read(force)
  }

  usage(home = userAntigravityHome(), force = false): Promise<AgentUsage> {
    for (const [key, probe] of this.quotas) if (probe.expired(60_000)) this.quotas.delete(key)
    const key = JSON.stringify([home, credentialRevision(home)])
    let probe = this.quotas.get(key)
    if (!probe) {
      probe = new CachedProbe(60_000, () => this.probe(home, homedir(), true).then((result) => parseUsage(result.report)))
      this.quotas.set(key, probe)
    }
    return probe.read(force)
  }

  private async probe(home: string, cwd: string, usage: boolean): Promise<{ listing: Listing; report: string }> {
    let commands: SlashCommandDto[] = []
    let report = ''
    let sessionId: string | null = null
    const client = new AcpClient({ label: 'antigravity-catalog', binary: await this.executable(), args: antigravityArgs(), cwd,
      env: antigravityEnv(home, home !== userAntigravityHome()), onStderr: () => {},
      onNotification: (method, params) => {
        if (method !== 'session/update') return
        const update = fields(fields(params).update)
        if (update.sessionUpdate === 'available_commands_update') commands = toSlashCommands(update.availableCommands)
        if (update.sessionUpdate === 'agent_message_chunk') report += String(fields(update.content).text ?? '')
      },
    })
    try {
      await client.initialize(CLIENT_INFO)
      const session = await client.request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] }, 60_000)
      sessionId = session.sessionId
      const models = modelCatalog(session)
      if (usage) {
        await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/usage' }] }, 60_000)
      } else {
        for (const model of models.models) {
          if (model.isDefault) continue
          const state = await client.request('session/set_config_option', { sessionId, configId: 'model', value: model.value })
          const current = modelCatalog(state).models.find((entry) => entry.isDefault)
          if (current) { model.efforts = current.efforts; model.defaultEffort = current.defaultEffort }
        }
      }
      return { listing: { models, commands }, report }
    } finally {
      await client.closeAndWait()
      // Probe sessions contain no user messages. Let the native process release
      // SQLite before removing only the files belonging to this probe.
      if (sessionId && /^[\w-]+$/.test(sessionId)) {
        const id = sessionId
        await Promise.all([
          ...['.db', '.db-wal', '.db-shm', '.meta'].map((suffix) => rm(join(home, 'antigravity-acp', 'conversations', id + suffix), { force: true }).catch(() => {})),
          rm(join(home, 'antigravity-acp', 'brain', id), { recursive: true, force: true }).catch(() => {}),
        ])
      }
    }
  }
}

/** The official /usage report is Markdown; no quota RPC is advertised in 1.4.3. */
export function parseUsage(report: string): Omit<AgentUsage, 'fetchedAt'> {
  const windows: AgentUsage['windows'] = []
  let group = ''
  for (const line of report.split('\n')) {
    const heading = /^- \*\*(.+)\*\*$/.exec(line)
    if (heading) group = heading[1]!
    const match = /^\s*- \*\*(.+?):\*\* (\d+)% remaining/.exec(line)
    if (match) windows.push({ id: `${group}:${match[1]}`, label: [group, match[1]].filter(Boolean).join(' · '), utilization: Math.max(0, Math.min(1, 1 - Number(match[2]) / 100)), resetsAt: null })
  }
  if (report.includes('Unable to retrieve quota')) throw new Error(report)
  return { agent: 'antigravity', plan: null, limitsAvailable: windows.length > 0, windows, credits: null }
}
