export { toSlashCommands } from '../acp/commands.js'
import { toSlashCommands } from '../acp/commands.js'
import { homedir } from 'node:os'
import { type SlashCommandDto } from '@sillage/protocol'
import { AcpClient } from '../acp/client.js'
import { CachedProbeMap } from '../cached-probe.js'
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
  /** Grok's built-in list, the account's never having come: kept a minute only. */
  provisional?: boolean
}

const TTL_MS = 60 * 60 * 1000
const PROVISIONAL_TTL_MS = 60 * 1000
const PROBE_TIMEOUT_MS = 30_000
/** The account's list follows a built-in one by ~150 ms (probed on 1.0.62); this leaves room for a slow network. */
export const MODELS_UPDATE_WAIT_MS = 3_000

/**
 * On a stale or missing `models_cache.json`, `initialize` gives the list built into the binary
 * (`grok-4.6`, `grok-4.5`, 500,000-token windows on 1.0.62) and the account's own arrives later
 * in `_x.ai/models/update` (`grok-4.7` as default, 256,000 tokens). Only the account's lists carry
 * `contextWindows` (1.0.62 and 1.0.94): the sign to wait rather than cache a list missing the
 * account's default model for an hour.
 */
export function builtInModels(state: Record<string, unknown>): boolean {
  const models = Array.isArray(state.availableModels) ? state.availableModels : []
  return models.length > 0 && models.every((model) => !Array.isArray(fields(fields(model)._meta).contextWindows))
}

/** Models follow the subscription: additional accounts probe inside their own `GROK_HOME`, one cache entry per home (empty for the CLI's own login). */
export class GrokCatalog {
  private readonly probes = new CachedProbeMap<GrokListing>(TTL_MS, (home) => this.read(home || undefined))

  constructor(private readonly executable: () => Promise<string>) {}

  invalidate(): void { this.probes.invalidate() }

  async list(home?: string, force = false): Promise<GrokListing & { fetchedAt: number }> {
    const listing = await this.probes.read(home ?? '', force)
    if (!force && listing.provisional && Date.now() - listing.fetchedAt >= PROVISIONAL_TTL_MS) return this.probes.read(home ?? '', true)
    return listing
  }

  private async read(home?: string): Promise<GrokListing> {
    let update: Record<string, unknown> | null = null
    let updated = () => {}
    const arrived = new Promise<void>((resolve) => { updated = resolve })
    const client = new AcpClient({
      label: 'grok',
      binary: await this.executable(),
      args: ['agent', '--no-leader', 'stdio'],
      cwd: home ?? homedir(),
      env: agentProcessEnv({ ...GROK_ISOLATION_ENV, ...(home ? { GROK_HOME: home } : {}) }),
      onNotification: (method, params) => {
        if (method !== '_x.ai/models/update') return
        update = fields(params)
        updated()
      },
    })
    const timeout = setTimeout(() => client.close(), PROBE_TIMEOUT_MS)
    try {
      const meta = fields((await client.initialize(CLIENT_INFO))._meta)
      let state = fields(meta.modelState)
      if (builtInModels(state)) {
        let waited: NodeJS.Timeout | undefined
        await Promise.race([arrived, new Promise<void>((resolve) => { waited = setTimeout(resolve, MODELS_UPDATE_WAIT_MS) })])
        clearTimeout(waited)
        state = update ?? state
      }
      return { ...readModels(state), commands: toSlashCommands(meta.availableCommands), provisional: builtInModels(state) }
    } finally {
      clearTimeout(timeout)
      client.close()
    }
  }
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
