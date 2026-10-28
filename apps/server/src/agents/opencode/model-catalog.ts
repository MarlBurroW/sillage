import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Agent, Command, Config, ResponseBody } from '@sillage/opencode-bindings'
import type { SlashCommandDto } from '@sillage/protocol'
import { usableSlashCommands } from '@sillage/protocol'
import { CachedProbe, CachedProbeMap } from '../cached-probe.js'
import { withProbeServer } from './probe.js'
import { toSlashCommands } from './runner.js'

/**
 * opencode catalogs from disposable server: connected-provider models, primary agents, directory
 * slash commands.
 *
 * Like other CLIs, no hardcoding; cache because probes start processes. Resolve binary per probe to
 * detect installation while daemon runs.
 */

type Providers = ResponseBody<'config.providers'>

interface Listing {
  providers: Providers['providers']
  defaults: Providers['default']
  /** Machine-configured model when named. */
  configured: string | null
  agents: Agent[]
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

  /**
   * GET /config/providers returns usable providers (credentials/free): offer these instead of GET
   * /provider listing roughly two hundred known providers.
   */
  private async probeModels(): Promise<Listing> {
    return withProbeServer(await this.executable(), homedir(), async (server) => {
      const [providers, agents, config] = await Promise.all([
        server.get<Providers>('/config/providers'),
        server.get<Agent[]>('/agent'),
        server.get<Config>('/config'),
      ])
      return {
        providers: providers.providers,
        defaults: providers.default,
        configured: config.model ?? null,
        agents,
      }
    })
  }

  private async probeCommands(cwd: string): Promise<{ commands: SlashCommandDto[] }> {
    return withProbeServer(await this.executable(), cwd, async (server) => ({
      commands: usableSlashCommands(toSlashCommands(await server.get<Command[]>('/command'))),
    }))
  }
}
