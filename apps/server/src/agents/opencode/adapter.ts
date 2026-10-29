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

/** Fork cut: last retained opencode message, null when no agent output precedes requested point. */
interface OpencodeForkCut {
  lastMessageId: string | null
}

/** Official installer location, added only to interactive-shell PATH; invisible to daemon. */
const INSTALLER_BINARY = join(homedir(), '.opencode/bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')

/**
 * Configured name or installer fallback when unresolved.
 *
 * Decided once at construction: later UI installations use Sillage prefix, checked by normal
 * resolution every launch.
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
   * v1 is first opencode serve API (/session/..., GET /event), probed 1.18.25/1.19.0/1.19.3. Second
   * (/api/session/..., session.next.*) lacks forks/MCP and ignores first-generation sessions;
   * adapter uses only one.
   */
  readonly rawFormat = 'opencode-server@v1'

  private readonly catalog: OpencodeCatalog
  readonly cli: CliBinary

  constructor(config: Config) {
    this.binary = configuredBinary(config.agents.opencode.binary, config.paths.agents)
    this.cli = new CliBinary('opencode', this.label, this.binary, config.agents.opencode.enabled, config.paths.agents)
    this.catalog = new OpencodeCatalog(() => this.cli.executable())
  }

  invalidateCatalogs(): void { this.catalog.invalidate() }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new OpencodeRunner(ctx)
  }

  /**
   * Runner stamps turn.completed/message parts with increasing native message IDs; maximum is
   * branch’s last message.
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
   * POST /session/{id}/fork copies messages before messageID, exclusive (probed): native cut is
   * message following last retained one; absent means keep all. Like Codex, fork does not restore
   * written files.
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

  async models(_credential?: string, force = false): Promise<AgentModelsDto> {
    const listing = await this.catalog.list(force)
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
          // Variants are opencode effort. None is default: no variant means model’s own settings.
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
      // Primary agents correspond to Codex collaboration modes. Hidden title/summary/compaction
      // agents are internal; subagents do not lead turns.
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
   * opencode has no plan/quota: providers bill independently, CLI reports per-message cost only.
   * limitsAvailable false conveys this without suggesting failure.
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
 * Model opencode would choose when unnamed: configured model, otherwise first usable provider
 * default.
 */
function defaultModel(listing: Awaited<ReturnType<OpencodeCatalog['list']>>): string | null {
  if (listing.configured) return listing.configured
  const first = listing.providers[0]
  const model = first ? listing.defaults[first.id] : undefined
  return first && model ? `${first.id}/${model}` : null
}
