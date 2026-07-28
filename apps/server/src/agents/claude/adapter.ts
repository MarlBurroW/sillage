import { forkSession } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_CAPABILITIES,
  CLI_DEFAULT,
  type AgentConfig,
  type AgentUsage,
  type ClaudeAccountDto,
  type ClaudeModelDto,
  type EditDiffDto,
} from '@sillage/protocol'
import type { Config } from '../../config.js'
import type { EventLog } from '../../events/event-log.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs, type ForkTarget } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
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
  private readonly catalog = new ClaudeModelCatalog()
  private readonly usageReader = new ClaudeUsageReader()

  constructor(config: Config) {
    this.binary = config.agents.claude.binary
  }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new ClaudeRunner(ctx)
  }

  forkCut(log: EventLog, conversationId: string, throughSeq: number): ClaudeForkCut {
    // L'identifiant de transcript ne vit que dans le payload natif conservé à la
    // traduction (invariant I3) : c'est là qu'on le relit.
    const raw = log.lastRawOfType(conversationId, 'message.completed', throughSeq)
    const uuid = (raw as { uuid?: unknown } | null)?.uuid
    return { upToMessageId: typeof uuid === 'string' ? uuid : null }
  }

  async fork(target: ForkTarget, cut: unknown): Promise<string> {
    const { upToMessageId } = cut as ClaudeForkCut
    if (!upToMessageId) {
      throw new ForkError(
        "Aucun message de l'agent avant ce point : il n'y a rien à reprendre dans la branche.",
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
        `Claude Code n'a pas pu forker la session : ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async models(): Promise<object> {
    const listing = await this.catalog.list()

    const models: ClaudeModelDto[] = listing.models.map((model) => ({
      value: model.value,
      resolvedModel: model.resolvedModel ?? null,
      displayName: model.displayName,
      description: model.description,
      supportedEffortLevels: model.supportedEffortLevels ?? [],
    }))

    const account: ClaudeAccountDto | null = listing.account
      ? {
          subscriptionType: listing.account.subscriptionType ?? null,
          organization: listing.account.organization ?? null,
          billedBySubscription: Boolean(listing.account.subscriptionType),
        }
      : null

    return { models, account, fetchedAt: listing.fetchedAt }
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
