import { homedir } from 'node:os'
import { usableSlashCommands, type SlashCommandDto } from '@sillage/protocol'
import { AcpClient } from '../acp/client.js'
import { CachedProbe } from '../cached-probe.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { agentProcessEnv } from '../process-env.js'
import { GROK_ISOLATION_ENV } from './launch.js'
import { fields } from './tools.js'

/** Grok Build models, efforts and slash-command catalog. Read disposable `grok agent stdio` initialization `_meta.modelState` and `_meta.availableCommands` without opening sessions that would persist in history. Cache because every read launches a process. */

export interface GrokModel {
  id: string
  name: string
  description: string
  contextTokens: number | null
  efforts: { id: string; label: string; description: string | null }[]
  defaultEffort: string | null
}

export interface GrokListing {
  models: GrokModel[]
  current: string | null
  commands: SlashCommandDto[]
}

const TTL_MS = 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 30_000

export class GrokCatalog {
  private readonly probe = new CachedProbe<GrokListing>(TTL_MS, () => this.read())

  constructor(private readonly executable: () => Promise<string>) {}

  list(force = false): Promise<GrokListing & { fetchedAt: number }> {
    return this.probe.read(force)
  }

  private async read(): Promise<GrokListing> {
    const client = new AcpClient({
      label: 'grok',
      binary: await this.executable(),
      args: ['agent', '--no-leader', 'stdio'],
      cwd: homedir(),
      env: agentProcessEnv(GROK_ISOLATION_ENV),
    })
    const timeout = setTimeout(() => client.close(), PROBE_TIMEOUT_MS)
    try {
      const meta = fields((await client.initialize(CLIENT_INFO))._meta)
      return { ...readModels(fields(meta.modelState)), commands: toSlashCommands(meta.availableCommands) }
    } finally {
      clearTimeout(timeout)
      client.close()
    }
  }
}

/** Grok commands normalized from ACP announcements. */
export function toSlashCommands(listed: unknown): SlashCommandDto[] {
  return usableSlashCommands((Array.isArray(listed) ? listed : []).flatMap((entry) => {
    const command = fields(entry)
    if (typeof command.name !== 'string' || !command.name) return []
    const hint = fields(command.input).hint
    return [{
      name: command.name,
      description: typeof command.description === 'string' ? command.description : '',
      argumentHint: typeof hint === 'string' ? hint : '',
      aliases: [],
    }]
  }))
}

function readModels(state: Record<string, unknown>): Omit<GrokListing, 'commands'> {
  const models = (Array.isArray(state.availableModels) ? state.availableModels : []).flatMap((entry): GrokModel[] => {
    const model = fields(entry)
    if (typeof model.modelId !== 'string') return []
    const meta = fields(model._meta)
    const efforts = (Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : []).map((value) => fields(value))
    return [{
      id: model.modelId,
      name: typeof model.name === 'string' ? model.name : model.modelId,
      description: typeof model.description === 'string' ? model.description : '',
      contextTokens: typeof meta.totalContextTokens === 'number' ? meta.totalContextTokens : null,
      // Grok lists highest effort first; composers expect lowest first.
      efforts: efforts
        .filter((effort) => typeof effort.id === 'string')
        .map((effort) => ({
          id: String(effort.id),
          label: typeof effort.label === 'string' ? effort.label : String(effort.id),
          description: typeof effort.description === 'string' ? effort.description : null,
        }))
        .reverse(),
      defaultEffort: (efforts.find((effort) => effort.default === true)?.id as string | undefined) ??
        (typeof meta.reasoningEffort === 'string' ? meta.reasoningEffort : null),
    }]
  })
  return { models, current: typeof state.currentModelId === 'string' ? state.currentModelId : null }
}
