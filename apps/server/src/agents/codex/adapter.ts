import {
  AGENT_CAPABILITIES,
  CLI_DEFAULT,
  type AgentConfig,
  type AgentUsage,
  type CodexMode,
  type CodexModeDto,
  type CodexModelDto,
  type EditDiffDto,
} from '@sillage/protocol'
import type { CollaborationModeMask, ThreadForkResponse } from '@sillage/codex-bindings/v2'
import type { Config } from '../../config.js'
import type { EventLog } from '../../events/event-log.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs, type ForkTarget } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'
import { describeEdit } from './file-edits.js'
import { CodexModelCatalog } from './model-catalog.js'
import { CodexRunner } from './runner.js'
import { CodexUsageReader } from './usage.js'

/**
 * Point de coupe d'un fork : nombre de tours à retirer depuis la fin de la branche.
 *
 * Codex ne sait pas couper à un message, seulement retirer des tours entiers
 * (`thread/rollback { numTurns }`). La granularité commune du fork est donc le tour,
 * ce qui tombe bien : c'est déjà le découpage de la réglette de navigation.
 */
interface CodexForkCut {
  turnsToDrop: number
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = 'codex' as const
  readonly label = 'Codex'
  readonly binary: string
  readonly capabilities = AGENT_CAPABILITIES.codex
  readonly rawFormat = 'codex-app-server@v2'

  private readonly catalog: CodexModelCatalog
  private readonly usageReader: CodexUsageReader

  constructor(config: Config) {
    this.binary = config.agents.codex.binary
    this.catalog = new CodexModelCatalog(this.binary)
    this.usageReader = new CodexUsageReader(this.binary)
  }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new CodexRunner(ctx)
  }

  forkCut(log: EventLog, conversationId: string, throughSeq: number): CodexForkCut {
    const turns = log.countByType(conversationId, 'turn.completed', throughSeq)
    return { turnsToDrop: Math.max(turns.total - turns.kept, 0) }
  }

  async fork(target: ForkTarget, cut: unknown): Promise<string> {
    const { turnsToDrop } = cut as CodexForkCut
    const client = new CodexAppServerClient({
      binary: this.binary,
      cwd: target.cwd,
      onNotification: () => {},
      onServerRequest: () =>
        Promise.reject(new Error('Aucune requête serveur attendue pendant un fork.')),
    })

    try {
      await client.initialize(CLIENT_INFO)

      const forked = await client.call<ThreadForkResponse, 'thread/fork'>('thread/fork', {
        threadId: target.agentSessionId,
      })
      const branchId = forked.thread.id

      // Le fork copie tout le fil : c'est le rollback qui le ramène au point de coupe.
      // Il ne revient pas sur les fichiers déjà écrits sur le disque, seulement sur la
      // conversation, et cette limite est dite à l'utilisateur plutôt que devinée.
      if (turnsToDrop > 0) {
        await client.call('thread/rollback', {
          threadId: branchId,
          numTurns: turnsToDrop,
        })
      }

      return branchId
    } catch (err) {
      throw new ForkError(
        `Codex n'a pas pu forker le fil : ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      client.close()
    }
  }

  async models(): Promise<object> {
    const listing = await this.catalog.list()

    const models: CodexModelDto[] = listing.models.map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
        value: effort.reasoningEffort,
        description: effort.description,
      })),
      defaultReasoningEffort: model.defaultReasoningEffort,
      isDefault: model.isDefault,
    }))

    // `mode` est nullable côté protocole : un préréglage qui ne désigne aucun mode ne
    // peut pas être proposé comme choix, il est écarté plutôt que rendu inerte.
    const modes: CodexModeDto[] = listing.modes
      .filter((mask): mask is CollaborationModeMask & { mode: CodexMode } => mask.mode !== null)
      .map((mask) => ({ mode: mask.mode, label: mask.name }))

    return { models, modes, fetchedAt: listing.fetchedAt }
  }

  usage(force: boolean): Promise<AgentUsage> {
    return this.usageReader.read(force)
  }

  async resolveDefaults(config: AgentConfig): Promise<AgentConfig> {
    if (config.agent !== 'codex') return config
    if (config.model !== CLI_DEFAULT && config.reasoningEffort !== CLI_DEFAULT) return config

    const { models } = await this.catalog.list().catch(() => ({ models: [] }))
    const chosen =
      models.find((model) => model.model === config.model) ??
      models.find((model) => model.isDefault) ??
      models[0]
    if (!chosen) return config

    return {
      ...config,
      model: config.model === CLI_DEFAULT ? chosen.model : config.model,
      reasoningEffort:
        config.reasoningEffort === CLI_DEFAULT
          ? chosen.defaultReasoningEffort
          : config.reasoningEffort,
    }
  }

  describeEdit({ log, conversationId, toolCallId, cwd, path }: DescribeEditArgs): EditDiffDto {
    const raw = log.rawOfTool(conversationId, toolCallId)
    return describeEdit(raw.completed, cwd, path)
  }
}
