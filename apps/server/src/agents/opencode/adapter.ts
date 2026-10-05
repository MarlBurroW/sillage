import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_CAPABILITIES,
  CLI_DEFAULT,
  type AgentConfig,
  type AgentModelDto,
  type AgentModelsDto,
  type AgentUsage,
  type EditDiffDto,
  type ProjectCommandsDto,
} from '@sillage/protocol'
import type { Message, Session } from '@sillage/opencode-bindings'
import type { Config } from '../../config.js'
import type { EventLog } from '../../events/event-log.js'
import { CliBinary, resolveBinary } from '../cli-binary.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs, type ForkTarget } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { OpencodeCatalog } from './model-catalog.js'
import { withProbeServer } from './probe.js'
import { OpencodeRunner } from './runner.js'
import { describeEdit } from './tools.js'

/**
 * Point de coupe d'un fork : le dernier message d'opencode à garder dans la branche.
 * Null quand rien de l'agent ne précède le point demandé.
 */
interface OpencodeForkCut {
  lastMessageId: string | null
}

/**
 * L'installeur officiel d'opencode pose le binaire ici, et n'ajoute ce dossier au PATH
 * que dans les fichiers du shell interactif : un daemon ne l'y voit pas.
 */
const INSTALLER_BINARY = join(homedir(), '.opencode/bin/opencode')

/**
 * Le nom configuré, ou le chemin de l'installeur quand ce nom ne mène nulle part.
 *
 * Décidé une fois, à la construction : un opencode installé ensuite depuis l'interface
 * atterrit dans le préfixe de Sillage, que la résolution ordinaire consulte à chaque
 * lancement.
 */
function configuredBinary(binary: string, managedDir: string): string {
  if (resolveBinary(binary, managedDir) !== null || binary !== 'opencode') return binary
  try {
    accessSync(INSTALLER_BINARY, constants.X_OK)
    return INSTALLER_BINARY
  } catch {
    return binary
  }
}

export class OpencodeAdapter implements AgentAdapter {
  readonly kind = 'opencode' as const
  readonly label = 'OpenCode'
  readonly binary: string
  readonly capabilities = AGENT_CAPABILITIES.opencode
  /**
   * `v1` désigne la première génération de l'API d'`opencode serve` (`/session/...`,
   * flux `GET /event`), sondée sur opencode 1.18.25. La seconde (`/api/session/...`,
   * événements `session.next.*`) n'a ni fork ni serveurs MCP, et son flux ignore les
   * sessions de la première : l'adaptateur n'en parle qu'une.
   */
  readonly rawFormat = 'opencode-server@v1'

  private readonly catalog: OpencodeCatalog
  readonly cli: CliBinary

  constructor(config: Config) {
    this.binary = configuredBinary(config.agents.opencode.binary, config.paths.agents)
    this.cli = new CliBinary('opencode', this.binary, config.agents.opencode.enabled, config.paths.agents)
    this.catalog = new OpencodeCatalog(() => this.cli.executable())
  }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new OpencodeRunner(ctx)
  }

  /**
   * Le runner estampille chaque `turn.completed` et chaque part de message de
   * l'identifiant du message natif. Ces identifiants sont croissants : le plus grand
   * des deux est le dernier message de la branche.
   */
  forkCut(log: EventLog, conversationId: string, throughSeq: number): OpencodeForkCut {
    const ids = [
      (log.lastRawOfType(conversationId, 'turn.completed', throughSeq) as { messageID?: unknown } | null)?.messageID,
      (log.lastRawOfType(conversationId, 'message.completed', throughSeq, { topLevelOnly: true }) as
        { part?: { messageID?: unknown } } | null)?.part?.messageID,
    ].filter((id): id is string => typeof id === 'string')
    return { lastMessageId: ids.sort().at(-1) ?? null }
  }

  /**
   * `POST /session/{id}/fork` copie les messages qui précèdent `messageID`, lui exclu
   * (sondé) : le point de coupe natif est donc le message qui suit le dernier à garder,
   * et son absence signifie « tout garder ». Comme chez Codex, le fork ne revient pas
   * sur les fichiers déjà écrits.
   */
  async fork(target: ForkTarget, cut: unknown): Promise<string> {
    const { lastMessageId } = cut as OpencodeForkCut
    if (!lastMessageId) {
      throw new ForkError('No agent message before this point: there is nothing to resume in the branch.')
    }

    try {
      return await withProbeServer(await this.cli.executable(), target.cwd, async (server) => {
        const messages = await server.get<{ info: Message }[]>(`/session/${target.agentSessionId}/message`)
        const next = messages.map((message) => message.info.id).sort().find((id) => id > lastMessageId)
        const forked = await server.post<Session>(
          `/session/${target.agentSessionId}/fork`,
          next ? { messageID: next } : {},
        )
        return forked.id
      })
    } catch (err) {
      throw new ForkError(
        `OpenCode could not fork the session: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async models(): Promise<AgentModelsDto> {
    const listing = await this.catalog.list()
    const fallback = defaultModel(listing)

    const models: AgentModelDto[] = listing.providers.flatMap((provider) =>
      Object.values(provider.models).map((model) => {
        const value = `${provider.id}/${model.id}`
        return {
          value,
          displayName: model.name,
          description: provider.name,
          hint: value,
          isDefault: value === fallback,
          // Les variantes sont l'effort d'opencode. Aucune n'est « par défaut » : sans
          // variante, le modèle tourne avec ses réglages propres.
          efforts: Object.keys(model.variants ?? {}).map((variant) => ({
            value: variant,
            label: variant,
            hint: null,
          })),
          defaultEffort: null,
          supportsFastMode: false,
        }
      }),
    )

    return {
      models,
      // Les agents primaires tiennent le rôle des modes de collaboration de Codex.
      // Les agents cachés (`title`, `summary`, `compaction`) sont ceux d'opencode
      // lui-même, et les sous-agents ne mènent pas un tour.
      modes: listing.agents
        .filter((agent) => agent.mode !== 'subagent' && !agent.hidden)
        .map((agent) => ({ mode: agent.name, label: agent.name, hint: agent.description ?? null })),
      account: null,
      outputStyles: [],
      fastMode: null,
      agents: listing.agents
        .filter((agent) => agent.mode !== 'primary' && !agent.hidden)
        .map((agent) => ({ name: agent.name, description: agent.description ?? '' })),
      fetchedAt: listing.fetchedAt,
    }
  }

  commands(cwd: string, force: boolean): Promise<ProjectCommandsDto> {
    return this.catalog.commands(cwd, force)
  }

  /**
   * opencode n'a ni forfait ni quota : chaque fournisseur facture le sien, et le CLI
   * ne rapporte qu'un coût par message. `limitsAvailable: false` le dit sans que ce
   * soit une panne.
   */
  async usage(): Promise<AgentUsage> {
    return {
      agent: 'opencode',
      plan: null,
      limitsAvailable: false,
      windows: [],
      credits: null,
      fetchedAt: Date.now(),
    }
  }

  async resolveDefaults(config: AgentConfig): Promise<AgentConfig> {
    if (config.agent !== 'opencode' || config.model !== CLI_DEFAULT) return config
    const model = await this.catalog.list().then(defaultModel).catch(() => null)
    return model ? { ...config, model } : config
  }

  describeEdit({ log, conversationId, toolCallId, cwd, path }: DescribeEditArgs): EditDiffDto {
    const raw = log.rawOfTool(conversationId, toolCallId)
    return describeEdit(raw.completed, cwd, path)
  }
}

/**
 * Le modèle qu'opencode prendrait sans qu'on lui en nomme un : celui que sa
 * configuration désigne, sinon le défaut du premier fournisseur utilisable.
 */
function defaultModel(listing: Awaited<ReturnType<OpencodeCatalog['list']>>): string | null {
  if (listing.configured) return listing.configured
  const first = listing.providers[0]
  const model = first ? listing.defaults[first.id] : undefined
  return first && model ? `${first.id}/${model}` : null
}
