import { forkSession } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_CAPABILITIES,
  CLI_DEFAULT,
  type AgentConfig,
  type AgentModelDto,
  type AgentModelsDto,
  type AgentUsage,
  type ClaudeAccountDto,
  type EditDiffDto,
} from '@sillage/protocol'
import type { Config } from '../../config.js'
import type { EventLog } from '../../events/event-log.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs, type ForkTarget } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { CliBinary } from '../cli-binary.js'
import { describeEdit } from './file-edits.js'
import { ClaudeModelCatalog } from './model-catalog.js'
import { ClaudeRunner } from './runner.js'
import { ClaudeUsageReader } from './usage.js'

/**
 * Point de coupe d'un fork : l'`uuid` d'une entrée du fichier de transcript.
 *
 * Ce n'est pas un identifiant d'API. Seules les entrées `user`, `attachment` et
 * `assistant` en portent un ; viser un message `result`, qui n'existe pas dans le
 * transcript, fait échouer le fork avec « Message <uuid> not found in session ».
 */
interface ClaudeForkCut {
  upToMessageId: string | null
}

/** Libellés des niveaux d'effort. Un niveau inconnu s'affiche par sa valeur. */
const EFFORT_LABELS: Record<string, string> = {
  low: 'Faible',
  medium: 'Moyen',
  high: 'Élevé',
  xhigh: 'Très élevé',
  max: 'Maximal',
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = 'claude' as const
  readonly label = 'Claude Code'
  readonly binary: string
  readonly capabilities = AGENT_CAPABILITIES.claude
  readonly rawFormat = 'claude-agent-sdk@0.3'

  /**
   * Un seul exemplaire de chaque sonde par daemon : catalogue et lecteur de quota
   * démarrent chacun un process CLI pour se remplir, ce qu'on ne veut pas refaire à
   * chaque requête. Deux caches distincts : les modèles ne bougent qu'entre deux
   * versions de CLI, la consommation change en permanence.
   */
  private readonly catalog: ClaudeModelCatalog
  private readonly usageReader: ClaudeUsageReader
  readonly cli: CliBinary

  constructor(config: Config) {
    this.binary = config.agents.claude.binary
    this.cli = new CliBinary('claude', this.binary, config.agents.claude.enabled, config.paths.agents)
    // Les deux sondes lancent le CLI via le SDK : elles ont besoin du même chemin absolu
    // que les conversations, sans quoi le réglage `agents.claude.binary` resterait sans
    // effet ici et le SDK retomberait sur un binaire que la release ne livre pas.
    this.catalog = new ClaudeModelCatalog(() => this.cli.executable())
    this.usageReader = new ClaudeUsageReader(() => this.cli.executable())
  }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new ClaudeRunner(ctx)
  }

  forkCut(log: EventLog, conversationId: string, throughSeq: number): ClaudeForkCut {
    // L'identifiant de transcript ne vit que dans le payload natif conservé à la
    // traduction (invariant I3) : c'est là qu'on le relit. Les messages de
    // sous-agents sont écartés : leur uuid appartient à une sidechain, et couper là
    // fait échouer le fork ou vise le mauvais point du fil principal.
    const raw = log.lastRawOfType(conversationId, 'message.completed', throughSeq, {
      topLevelOnly: true,
    })
    const uuid = (raw as { uuid?: unknown } | null)?.uuid
    return { upToMessageId: typeof uuid === 'string' ? uuid : null }
  }

  async fork(target: ForkTarget, cut: unknown): Promise<string> {
    const { upToMessageId } = cut as ClaudeForkCut
    if (!upToMessageId) {
      throw new ForkError(
        'No agent message before this point: there is nothing to resume in the branch.',
      )
    }

    try {
      const forked = await forkSession(target.agentSessionId, {
        dir: target.cwd,
        upToMessageId,
      })
      return forked.sessionId
    } catch (err) {
      throw new ForkError(
        `Claude Code could not fork the session: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async models(): Promise<AgentModelsDto> {
    const listing = await this.catalog.list()

    const models: AgentModelDto[] = listing.models.map((model) => {
      const efforts = model.supportedEffortLevels ?? []
      return {
        value: model.value,
        displayName: model.displayName,
        description: model.description,
        // L'id canonique derrière un alias : sans lui, « Opus » ne dit pas quelle
        // génération va effectivement répondre.
        hint: model.resolvedModel ?? null,
        isDefault: model.value === 'default',
        efforts: efforts.map((level) => ({
          value: level,
          label: EFFORT_LABELS[level] ?? level,
          hint: null,
        })),
        // `medium` est le défaut historique du CLI ; un modèle qui ne le connaît pas
        // retombe sur son premier niveau plutôt que sur une valeur inventée.
        defaultEffort: efforts.includes('medium') ? 'medium' : (efforts[0] ?? null),
      }
    })

    const account: ClaudeAccountDto | null = listing.account
      ? {
          subscriptionType: listing.account.subscriptionType ?? null,
          organization: listing.account.organization ?? null,
          billedBySubscription: Boolean(listing.account.subscriptionType),
        }
      : null

    return { models, modes: [], account, fetchedAt: listing.fetchedAt }
  }

  usage(force: boolean): Promise<AgentUsage> {
    return this.usageReader.read(force)
  }

  async resolveDefaults(config: AgentConfig): Promise<AgentConfig> {
    if (config.agent !== 'claude' || config.model !== CLI_DEFAULT) return config
    const { models } = await this.catalog.list().catch(() => ({ models: [] }))
    const fallback = models.find((model) => model.value === 'default') ?? models[0]
    return fallback ? { ...config, model: fallback.value } : config
  }

  describeEdit({ log, conversationId, toolCallId, path }: DescribeEditArgs): EditDiffDto {
    const raw = log.rawOfTool(conversationId, toolCallId)
    return describeEdit(
      raw.started,
      path,
      log.fileEditAction(conversationId, toolCallId, path) ?? 'modified',
    )
  }
}
