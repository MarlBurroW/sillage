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
  type ClaudeSessionDto,
  type EditDiffDto,
  type ProjectCommandsDto,
} from '@sillage/protocol'
import type { Message, Session } from '@sillage/opencode-bindings'
import type { MessageInfo, SessionInfo } from '@sillage/opencode-bindings/v2'
import type { Config } from '../../config.js'
import type { EventLog } from '../../events/event-log.js'
import { CliBinary, resolveBinary } from '../cli-binary.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs, type ForkTarget } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { OpencodeCatalog } from './model-catalog.js'
import { withProbeServer } from './probe.js'
import type { OpencodeServer } from './server.js'
import { OpencodeRunnerSwitch } from './runner-switch.js'
import { describeEdit } from './tools.js'
import { historyPages } from './v2/history.js'
import { describeEdit as describeEdit2 } from './v2/tools.js'

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
   * Default stamp: the 1.x server API (/session/..., GET /event), probed 1.18.25/1.19.0/1.19.3.
   * Runners on an OpenCode 2 binary stamp 'opencode-server@v2' themselves (see runner-switch.ts);
   * a conversation begun on 1.x and resumed on 2.x holds both.
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
    return new OpencodeRunnerSwitch(ctx)
  }

  /**
   * Runner stamps turn.completed/message parts with increasing native message IDs; maximum is
   * branch’s last message. Both majors share the turn stamp; a message carries its ID under
   * `part` on 1.x and `data.assistantMessageID` on 2.x, and IDs survive the 1.x → 2.x migration.
   */
  forkCut(log: EventLog, conversationId: string, throughSeq: number): OpencodeForkCut {
    const message = log.lastRawOfType(conversationId, 'message.completed', throughSeq, { topLevelOnly: true }) as
      { part?: { messageID?: unknown }; data?: { assistantMessageID?: unknown } } | null
    const ids = [
      (log.lastRawOfType(conversationId, 'turn.completed', throughSeq) as { messageID?: unknown } | null)?.messageID,
      message?.part?.messageID,
      message?.data?.assistantMessageID,
    ].filter((id): id is string => typeof id === 'string')
    return { lastMessageId: ids.sort().at(-1) ?? null }
  }

  /**
   * POST /session/{id}/fork copies messages before messageID, exclusive (probed): native cut is
   * message following last retained one; absent means keep all. 2.x keeps the semantics under
   * `POST /api/session/{id}/fork {before}` (probed 2.4.1). Like Codex, fork does not restore
   * written files.
   */
  async fork(target: ForkTarget, cut: unknown): Promise<string> {
    const { lastMessageId } = cut as OpencodeForkCut
    if (!lastMessageId) {
      throw new ForkError('No agent message before this point: there is nothing to resume in the branch.')
    }

    try {
      return await withProbeServer(await this.cli.executable(), target.cwd, async (server, generation) => {
        if (generation === 2) {
          // Read oldest first until the cut is passed: one unpaged read only sees the last 50.
          let next: string | undefined
          for await (const page of historyPages((path) => server.get(path), target.agentSessionId)) {
            next = page.map((message) => message.id).sort().find((id) => id > lastMessageId)
            if (next) break
          }
          const forked = await server.post<{ data: SessionInfo }>(`/api/session/${target.agentSessionId}/fork`, next ? { before: next } : {})
          return forked.data.id
        }
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

  /**
   * Root sessions OpenCode keeps for a directory, newest first, for adoption into Sillage. 2.x
   * only: it stores structured history the runner can replay; on 1.x the list stays empty.
   */
  async nativeSessions(cwd: string): Promise<ClaudeSessionDto[]> {
    return withProbeServer(await this.cli.executable(), cwd, async (server, generation) => {
      if (generation !== 2) return []
      const query = new URLSearchParams({ directory: cwd, parentID: 'null', archived: 'false', order: 'desc', limit: '100' })
      const { data } = await server.get<{ data: SessionInfo[] }>(`/api/session?${query}`)
      // OpenCode titles a session a few seconds after its first answer: a session just begun has
      // none yet. Name it by its first prompt instead of a bare ID (one read each, bounded).
      let untitled = 0
      return Promise.all(data.map(async (session) => {
        const prompt = session.title || untitled++ >= UNTITLED_PROMPT_READS ? null : await firstPrompt(server, session.id)
        return {
          sessionId: session.id,
          title: session.title || prompt || session.id,
          firstPrompt: prompt,
          gitBranch: null,
          lastModified: session.time.updated,
        }
      }))
    })
  }

  async models(_credential?: string, force = false): Promise<AgentModelsDto> {
    const listing = await this.catalog.list(force)

    const models: AgentModelDto[] = listing.models.map((model) => ({
      value: model.value,
      displayName: model.name,
      description: model.provider,
      hint: model.value,
      group: model.group,
      isDefault: model.value === listing.defaultModel,
      // Variants are opencode effort. None is default: no variant means model’s own settings.
      efforts: model.variants.map((variant) => ({ value: variant, label: variant, hint: null })),
      defaultEffort: null,
      supportsFastMode: false,
    }))

    return {
      models,
      // Primary agents correspond to Codex collaboration modes. Hidden title/summary/compaction
      // agents are internal; subagents do not lead turns.
      modes: listing.agents
        .filter((agent) => agent.mode !== 'subagent' && !agent.hidden)
        .map((agent) => ({ mode: agent.value, label: agent.label, hint: agent.description })),
      account: null,
      outputStyles: [],
      fastMode: null,
      agents: listing.agents
        .filter((agent) => agent.mode !== 'primary' && !agent.hidden)
        .map((agent) => ({ name: agent.value, description: agent.description ?? '' })),
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
    const model = await this.catalog.list().then((listing) => listing.defaultModel).catch(() => null)
    return model ? { ...config, model } : config
  }

  describeEdit({ log, conversationId, toolCallId, cwd, path }: DescribeEditArgs): EditDiffDto {
    const raw = log.rawOfTool(conversationId, toolCallId)
    return describeEdit2(raw.completed, cwd, path) ?? describeEdit(raw.completed, cwd, path)
  }
}

/** Untitled sessions named by their first prompt in one listing; older ones keep their ID. */
const UNTITLED_PROMPT_READS = 10

async function firstPrompt(server: OpencodeServer, sessionId: string): Promise<string | null> {
  try {
    const { data } = await server.get<{ data: MessageInfo[] }>(`/api/session/${sessionId}/message?order=asc&limit=5`)
    const text = data.find((message) => message.type === 'user')?.text.trim()
    return text ? (text.length > 80 ? `${text.slice(0, 79)}…` : text) : null
  } catch {
    return null
  }
}
