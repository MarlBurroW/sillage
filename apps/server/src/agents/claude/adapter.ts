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
  type FastModeAvailabilityDto,
  type ProjectCommandsDto,
} from '@sillage/protocol'
import type { Config } from '../../config.js'
import type { EventLog } from '../../events/event-log.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs, type ForkTarget } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { CliBinary } from '../cli-binary.js'
import { ClaudeCommandCatalog } from './command-catalog.js'
import { describeEdit } from './file-edits.js'
import { ClaudeModelCatalog } from './model-catalog.js'
import { ClaudeRunner } from './runner.js'
import { parseClaudeCredential } from './credential.js'
import { ClaudeUsageReader, claudeAccountUsage } from './usage.js'

/** Fork cut points are transcript-entry `uuid`, not API IDs. Only `user`, `attachment` and `assistant` entries have them; nonexistent transcript `result` messages cause 'Message <uuid> not found in session'. */
interface ClaudeForkCut {
  upToMessageId: string | null
}

/** English effort labels for API clients. Web uses them only as fallbacks and translates values because servers do not know user languages. */
const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = 'claude' as const
  readonly label = 'Claude Code'
  readonly binary: string
  readonly capabilities = AGENT_CAPABILITIES.claude
  readonly rawFormat = 'claude-agent-sdk@0.3'

  /** One catalog and quota probe per daemon: both launch CLIs, so avoid repeating per request. Separate caches because models change only between CLI versions while usage changes continuously. */
  private readonly catalog: ClaudeModelCatalog
  private readonly commandCatalog: ClaudeCommandCatalog
  private readonly usageReader: ClaudeUsageReader
  readonly cli: CliBinary

  constructor(config: Config) {
    this.binary = config.agents.claude.binary
    this.cli = new CliBinary('claude', this.binary, config.agents.claude.enabled, config.paths.agents)
    // Both SDK probes need conversation-resolved absolute paths;
    // otherwise `agents.claude.binary` would be ignored
    // and SDKs would select unbundled binaries.
    this.catalog = new ClaudeModelCatalog(() => this.cli.executable())
    this.commandCatalog = new ClaudeCommandCatalog(() => this.cli.executable())
    this.usageReader = new ClaudeUsageReader(() => this.cli.executable())
  }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new ClaudeRunner(ctx)
  }

  forkCut(log: EventLog, conversationId: string, throughSeq: number): ClaudeForkCut {
    // Transcript IDs exist only in native payloads retained during normalization
    // (invariant I3), so read them there. Exclude subagents:
    // their UUIDs belong to sidechains and cuts there
    // would fail or target incorrect points in the main conversation.
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

  /** `credential` is an account's encoded authentication; see `claudeCredential`. */
  async models(credential?: string, force = false): Promise<AgentModelsDto> {
    const listing = await this.catalog.list(credential, force)

    const models: AgentModelDto[] = listing.models.map((model) => {
      const efforts = model.supportedEffortLevels ?? []
      return {
        value: model.value,
        displayName: model.displayName,
        description: model.description,
        // Canonical IDs behind aliases: 'Opus' alone does not identify
        // which generation will actually respond.
        hint: model.resolvedModel ?? null,
        isDefault: model.value === 'default',
        efforts: efforts.map((level) => ({
          value: level,
          label: EFFORT_LABELS[level] ?? level,
          hint: null,
        })),
        // `medium` is the historical CLI default; models lacking it
        // use their first level rather than invented values.
        defaultEffort: efforts.includes('medium') ? 'medium' : (efforts[0] ?? null),
        supportsFastMode: model.supportsFastMode === true,
      }
    })

    const account: ClaudeAccountDto | null = listing.account
      ? {
          subscriptionType: listing.account.subscriptionType ?? null,
          organization: listing.account.organization ?? null,
          billedBySubscription: Boolean(listing.account.subscriptionType),
        }
      : null

    // Available unless CLIs name blockers. `sdk_opt_in_required` is not one:
    // probes show it is normal for eligible accounts,
    // because sessions must request the mode. Null for older CLIs unable
    // to report support, hiding settings rather than offering them blindly.
    const { state, reason } = listing.fastMode
    const available = state !== 'off' || reason === null || reason === 'sdk_opt_in_required'
    const fastMode: FastModeAvailabilityDto | null =
      state === null ? null : { available, reason: available ? null : reason }

    return {
      models,
      modes: [],
      account,
      // default is obtained without requesting a style: it corresponds to an empty
      // configuration value rather than another selectable entry.
      outputStyles: listing.outputStyles.filter((style) => style !== 'default'),
      fastMode,
      agents: listing.agents.map((agent) => ({ name: agent.name, description: agent.description })),
      fetchedAt: listing.fetchedAt,
    }
  }

  usage(force: boolean): Promise<AgentUsage> {
    return this.usageReader.read(force)
  }

  /** `credential` is the account's encoded authentication (see `claudeCredential`); API keys have no plan to read. */
  usageForAccount(accountId: string, credential: string, force: boolean): Promise<AgentUsage> {
    const parsed = parseClaudeCredential(credential)
    if (!parsed || parsed.kind !== 'oauth') return Promise.resolve(claudeAccountUsage())
    return this.usageReader.readForToken(accountId, parsed.token, force)
  }

  commands(cwd: string, force: boolean): Promise<ProjectCommandsDto> {
    return this.commandCatalog.list(cwd, force)
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
