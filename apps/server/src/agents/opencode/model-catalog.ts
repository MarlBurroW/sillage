import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Agent, Command, Config, ResponseBody } from '@sillage/opencode-bindings'
import type { SlashCommandDto } from '@sillage/protocol'
import { usableSlashCommands } from '@sillage/protocol'
import { CachedProbe, CachedProbeMap } from '../cached-probe.js'
import { withProbeServer } from './probe.js'
import { toSlashCommands } from './runner.js'

/**
 * Catalogues d'opencode, lus sur un serveur jetable : modèles des fournisseurs
 * connectés, agents primaires, et commandes en `/` d'un dossier.
 *
 * Même contrat que pour les deux autres CLI : rien n'est codé en dur, et tout est mis
 * en cache parce que chaque sonde démarre un process. Le binaire est résolu à chaque
 * sonde, pour voir une version installée pendant que le daemon tourne.
 */

type Providers = ResponseBody<'config.providers'>

interface Listing {
  providers: Providers['providers']
  defaults: Providers['default']
  /** Modèle nommé par la configuration du poste (`model`), quand elle en nomme un. */
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

  list(): Promise<Listing & { fetchedAt: number }> {
    return this.models.read()
  }

  commands(cwd: string, force = false): Promise<{ commands: SlashCommandDto[]; fetchedAt: number }> {
    return this.commandProbes.read(cwd, force)
  }

  /**
   * `GET /config/providers` ne rend que les fournisseurs utilisables (identifiants
   * présents, ou gratuits) : c'est la liste à proposer, là où `GET /provider` énumère
   * les quelque deux cents qu'opencode connaît.
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
