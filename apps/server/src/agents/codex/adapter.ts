import {
  AGENT_CAPABILITIES,
  CLI_DEFAULT,
  type AgentConfig,
  type AgentModelDto,
  type AgentModelsDto,
  type AgentUsage,
  type CodexMode,
  type CodexModeDto,
  type EditDiffDto,
  type ProjectCommandsDto,
} from '@sillage/protocol'
import type { CollaborationModeMask, ThreadForkResponse } from '@sillage/codex-bindings/v2'
import type { Config } from '../../config.js'
import type { EventLog } from '../../events/event-log.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs, type ForkTarget } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { CliBinary } from '../cli-binary.js'
import { CodexAppServerClient } from './app-server-client.js'
import { CLIENT_INFO } from './client-info.js'
import { describeEdit } from './file-edits.js'
import { CodexModelCatalog } from './model-catalog.js'
import { CodexRunner } from './runner.js'
import { CodexUsageReader } from './usage.js'

/**
 * Fork boundary: native ID of the last retained turn. Codex cuts only at complete-turn ends
 * (inclusive thread/fork lastTurnId), not messages, matching turn navigation granularity. Null
 * means retain the whole thread. Previous remove-turn-count rollback used thread/rollback, removed
 * in Codex 0.156.0. Recover IDs from native turn/completed stored beside turn.completed (invariant
 * I3).
 */
interface CodexForkCut {
  lastTurnId: string | null
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = 'codex' as const
  readonly label = 'Codex'
  readonly binary: string
  readonly capabilities = AGENT_CAPABILITIES.codex
  readonly rawFormat = 'codex-app-server@v2'

  private readonly catalog: CodexModelCatalog
  private readonly usageReader: CodexUsageReader
  readonly cli: CliBinary

  constructor(config: Config) {
    this.binary = config.agents.codex.binary
    this.cli = new CliBinary('codex', this.label, this.binary, config.agents.codex.enabled, config.paths.agents)
    // Configured names alone are insufficient: spawn resolves PATH while Sillage's
    // managed-install prefix takes precedence. Probing bare names would list
    // models from versions conversations do not use.
    this.catalog = new CodexModelCatalog(() => this.cli.executable())
    this.usageReader = new CodexUsageReader(() => this.cli.executable())
  }

  invalidateCatalogs(): void { this.catalog.invalidate() }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new CodexRunner(ctx)
  }

  forkCut(log: EventLog, conversationId: string, throughSeq: number): CodexForkCut {
    const turns = log.countByType(conversationId, 'turn.completed', throughSeq)
    // Nothing follows the boundary, so no turn ID is needed. Older logs lacking
    // native notifications thus remain forkable in full.
    if (turns.kept === turns.total) return { lastTurnId: null }
    if (turns.kept === 0) {
      throw new ForkError(
        'No completed turn before this point: there is nothing to resume in the branch.',
      )
    }
    const raw = log.lastRawOfType(conversationId, 'turn.completed', throughSeq) as
      | { turn?: { id?: unknown } }
      | null
    const lastTurnId = raw?.turn?.id
    if (typeof lastTurnId !== 'string') {
      throw new ForkError(
        'The journal does not record the native id of the last kept turn: this conversation predates the fork cut by turn id.',
      )
    }
    return { lastTurnId }
  }

  async fork(target: ForkTarget, cut: unknown): Promise<string> {
    const { lastTurnId } = cut as CodexForkCut
    const client = new CodexAppServerClient({
      binary: await this.cli.executable(),
      cwd: target.cwd,
      onNotification: () => {},
      onServerRequest: () =>
        Promise.reject(new Error('Aucune requête serveur attendue pendant un fork.')),
    })

    try {
      await client.initialize(CLIENT_INFO)

      const forked = await client.call<ThreadForkResponse, 'thread/fork'>('thread/fork', {
        threadId: target.agentSessionId,
        // Fork ends inclusively at the designated turn (probed on codex-cli 0.162.1). It
        // rewinds only conversation history, not files already written on disk;
        // explain this limitation rather than expecting users to infer it.
        ...(lastTurnId === null ? {} : { lastTurnId }),
        // Only the ID is needed; full history may weigh tens of megabytes.
        excludeTurns: true,
      })
      return forked.thread.id
    } catch (err) {
      throw new ForkError(
        `Codex could not fork the thread: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      client.close()
    }
  }

  /** `home` is the account's `CODEX_HOME`; see CodexAccountHomes. */
  async models(home?: string, force = false): Promise<AgentModelsDto> {
    const listing = await this.catalog.list(home, force)

    const models: AgentModelDto[] = listing.models.map((model) => ({
      value: model.model,
      displayName: model.displayName,
      description: model.description,
      hint: null,
      isDefault: model.isDefault,
      // Protocol strings have no display labels: use the value as
      // label and CLI description as tooltip.
      efforts: model.supportedReasoningEfforts.map((effort) => ({
        value: effort.reasoningEffort,
        label: effort.reasoningEffort,
        hint: effort.description,
      })),
      defaultEffort: model.defaultReasoningEffort,
      supportsFastMode: false,
    }))

    // Protocol mode is nullable: presets identifying no mode cannot be offered,
    // so omit them instead of rendering inert choices.
    const modes: CodexModeDto[] = listing.modes
      .filter((mask): mask is CollaborationModeMask & { mode: CodexMode } => mask.mode !== null)
      .map((mask) => ({ mode: mask.mode, label: mask.name }))

    // No output styles, fast mode, or named subagents: these are Claude Code
    // concepts. Empty values hide their corresponding controls.
    return {
      models,
      modes,
      account: null,
      outputStyles: [],
      fastMode: null,
      agents: [],
      fetchedAt: listing.fetchedAt,
    }
  }

  /** Codex exposes no slash commands: skills use dollar prefixes, published after session startup. */
  async commands(): Promise<ProjectCommandsDto> {
    return { commands: [], fetchedAt: Date.now() }
  }

  usage(force: boolean): Promise<AgentUsage> {
    return this.usageReader.read(force)
  }

  /** credential is the account's CODEX_HOME; see CodexAccountHomes. */
  usageForAccount(accountId: string, credential: string, force: boolean): Promise<AgentUsage> {
    return this.usageReader.readForAccount(accountId, credential, force)
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
