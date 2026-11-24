import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Agent, Command, Config, ResponseBody } from '@sillage/opencode-bindings'
import type { ModelRef } from '@sillage/opencode-bindings/v2'
import type { SlashCommandDto } from '@sillage/protocol'
import { usableSlashCommands } from '@sillage/protocol'
import { CachedProbe, CachedProbeMap } from '../cached-probe.js'
import { withProbeServer } from './probe.js'
import type { OpencodeServer } from './server.js'
import { toSlashCommands } from './runner.js'
import { readAgents2, readCommands2, readModels2, toSlashCommands2 } from './v2/catalog.js'

/**
 * opencode catalogs from disposable server: connected-provider models, primary agents, directory
 * slash commands.
 *
 * Like other CLIs, no hardcoding; cache because probes start processes. Resolve binary per probe to
 * detect installation while daemon runs. Both majors land in one shape, so the adapter never asks
 * which server answered.
 */

type Providers = ResponseBody<'config.providers'>

export interface CatalogModel {
  /** `provider/model`, as conversations store it. */
  value: string
  name: string
  provider: string
  /** opencode effort variants. */
  variants: string[]
}

export interface CatalogAgent {
  /** What prompts name: the 1.x name, the 2.x ID. */
  value: string
  label: string
  description: string | null
  mode: 'primary' | 'subagent' | 'all'
  hidden: boolean
}

interface Listing {
  models: CatalogModel[]
  /** Model opencode would choose when unnamed. */
  defaultModel: string | null
  agents: CatalogAgent[]
}

const MODELS_TTL_MS = 60 * 60 * 1000
const COMMANDS_TTL_MS = 5 * 60 * 1000

export class OpencodeCatalog {
  private readonly models = new CachedProbe(MODELS_TTL_MS, () => this.probeModels())
  private readonly commandProbes = new CachedProbeMap<{ commands: SlashCommandDto[] }>(
    COMMANDS_TTL_MS,
    (cwd) => this.probeCommands(cwd),
    (cwd) => resolve(cwd),
  )

  constructor(private readonly executable: () => Promise<string>) {}

  invalidate(): void {
    this.models.invalidate()
    this.commandProbes.invalidate()
  }

  list(force = false): Promise<Listing & { fetchedAt: number }> {
    return this.models.read(force)
  }

  commands(cwd: string, force = false): Promise<{ commands: SlashCommandDto[]; fetchedAt: number }> {
    return this.commandProbes.read(cwd, force)
  }

  private async probeModels(): Promise<Listing> {
    return withProbeServer(await this.executable(), homedir(), (server, generation) =>
      generation === 2 ? listing2(server) : listing1(server))
  }

  private async probeCommands(cwd: string): Promise<{ commands: SlashCommandDto[] }> {
    return withProbeServer(await this.executable(), cwd, async (server, generation) => ({
      commands: usableSlashCommands(generation === 2
        ? toSlashCommands2(await readCommands2(server))
        : toSlashCommands(await server.get<Command[]>('/command'))),
    }))
  }
}

/**
 * 1.x: GET /config/providers returns usable providers (credentials/free), rather than GET
 * /provider listing roughly two hundred known providers.
 */
async function listing1(server: OpencodeServer): Promise<Listing> {
  const [providers, agents, config] = await Promise.all([
    server.get<Providers>('/config/providers'),
    server.get<Agent[]>('/agent'),
    server.get<Config>('/config'),
  ])
  const first = providers.providers[0]
  const fallback = first ? providers.default[first.id] : undefined
  return {
    models: providers.providers.flatMap((provider) => Object.values(provider.models).map((model) => ({
      value: `${provider.id}/${model.id}`,
      name: model.name,
      provider: provider.name,
      variants: Object.keys(model.variants ?? {}),
    }))),
    defaultModel: config.model ?? (first && fallback ? `${first.id}/${fallback}` : null),
    agents: agents.map((agent) => ({
      value: agent.name, label: agent.name, description: agent.description ?? null, mode: agent.mode, hidden: agent.hidden === true,
    })),
  }
}

/**
 * 2.x: GET /api/model already holds only usable models (probed 2.4.1: the free ones without
 * credentials). Variants include `default`, which means the model's own settings: Sillage's
 * "no variant".
 */
async function listing2(server: OpencodeServer): Promise<Listing> {
  const [models, fallback, agents] = await Promise.all([
    readModels2(server),
    server.get<{ data: ModelRef | null }>('/api/model/default'),
    readAgents2(server),
  ])
  const usable = models.filter((model) => model.enabled && model.status !== 'deprecated')
  const first = usable[0]
  return {
    models: usable.map((model) => ({
      value: `${model.providerID}/${model.id}`,
      name: model.name,
      provider: model.providerID,
      variants: model.variants.map((variant) => variant.id).filter((id) => id !== 'default'),
    })),
    defaultModel: fallback.data ? `${fallback.data.providerID}/${fallback.data.id}` : first ? `${first.providerID}/${first.id}` : null,
    agents: agents.map((agent) => ({
      value: agent.id, label: agent.name, description: agent.description ?? null, mode: agent.mode, hidden: agent.hidden,
    })),
  }
}
