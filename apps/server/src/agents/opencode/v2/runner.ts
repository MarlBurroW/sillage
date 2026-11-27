import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  parseSlashCommand,
  usableSlashCommands,
  type AgentConfig,
  type BackgroundTask,
  type BackgroundTaskOutput,
  type McpServer,
  type McpServerStatus,
  type OpencodeConfig,
} from '@sillage/protocol'
import type {
  Event,
  EventData,
  FileAttachment,
  FormAnswer,
  FormInfo,
  JobInfo,
  MessageInfo,
  McpServer as NativeMcpServer,
  ModelRef,
  PermissionReply,
  SessionInfo,
  StructuredError,
  TokenUsage,
} from '@sillage/opencode-bindings/v2'
import type {
  AgentRunner,
  ElicitationAnswer,
  OutgoingAttachment,
  OutgoingMention,
  PermissionDecision,
  PlanReview,
  QuestionAnswer,
  RunnerContext,
} from '../../types.js'
import { TurnLifecycle } from '../../turn-lifecycle.js'
import { PendingInteractions } from '../../interactions.js'
import { failedStatuses } from '../../mcp-registry.js'
import { describeOutgoingMessage } from '../../outgoing.js'
import { agentProcessEnv } from '../../process-env.js'
import { journalDeath } from '../../session-close.js'
import { opencodeErrorCode } from '../errors.js'
import { parseModel } from '../model.js'
import { readAgents2, readCommands2, readModels2, readSkills2, toAgentSkills, toSlashCommands2 } from './catalog.js'
import { OpencodeServer } from '../server.js'
import { fromOpencode2McpStatus, toOpencode2Config, type Opencode2Config } from './config.js'
import { historyEvents, historyPages } from './history.js'
import { agentMentions, type AgentMention } from './mentions.js'
import { SessionGrants } from './permissions.js'
import { elicitationAnswer, formElicitation, formQuestions, isQuestionForm, questionAnswer } from './forms.js'
import {
  contentText,
  describePermission,
  describeTool,
  fileEdits,
  QUESTION_TOOL,
  SUBAGENT_TOOL,
  type CompletedCall,
} from './tools.js'
import { detach } from '../../../detach.js'

/**
 * OpenCode 2 adapter: translates the 2.x `opencode serve` stream (`/api/...`, `GET /api/event`)
 * into the common event schema. Probed on 2.4.1.
 *
 * Same shape as the 1.x runner: one server per conversation, permissions/MCP/skills read at
 * launch. What 2.x changed, and this runner follows:
 *
 * - Events are flat and typed (`session.text.delta`, `session.tool.success`…) instead of message
 *   parts to diff.
 * - Model, agent and Sillage's instructions are durable session state, set through their own
 *   routes, instead of fields resent with every prompt.
 * - Questions became forms; MCP elicitations travel the same way, which 1.x never forwarded.
 * - Subagents always run in the background. The parent turn ends right after launching them;
 *   each result reaches the parent's inbox and starts a new execution with no message from
 *   Sillage. Those wake-up turns open like any other: `session.execution.started`.
 */

export const OPENCODE2_RAW_FORMAT = 'opencode-server@v2'

/** Time for opencode to close interrupted turns before forcing idle. */
const INTERRUPT_GRACE_MS = 15_000

/** Wait at start for a fresh server's model list; beyond it the session starts without gauge. */
const START_MODELS_FILL_MS = 3_000

/** Live shell output: reading interval while a shell call runs. */
const SHELL_POLL_MS = 400

/** Background shell output shown on demand: the same tail as Claude's. */
const BACKGROUND_OUTPUT_BYTES = 8192

/** Instruction entry carrying Sillage's system-prompt appendix in the session. */
const INSTRUCTIONS_KEY = 'sillage'

/** Events unrelated to the conversation, or already covered by others. */
const NOISE = [
  'server.', 'location.', 'models-dev.', 'credential.', 'integration.', 'provider.', 'model.', 'agent.',
  'plugin.', 'project.', 'worktree.', 'config.', 'reference.', 'filesystem.', 'pty.', 'persistent-pty.',
  'shell.', 'websearch.', 'artifact.', 'tui.', 'installation.', 'vcs.', 'mcp.resources.', 'experimental.mcp.',
  'session.agent.', 'session.model.', 'session.moved', 'session.metadata.', 'session.permissions',
  'session.viewed', 'session.archived', 'session.unarchived', 'session.deleted',
  'session.forked', 'session.inbox.delivered', 'session.inbox.cancelled', 'session.inbox.delivery.',
  'session.instructions.', 'session.synthetic', 'session.skill.', 'session.shell.', 'session.step.first-token',
  'session.step.streamed', 'session.tool.input.delta', 'session.compaction.delta', 'session.revert.',
  // Phone pairing for push notifications (2.4.2): nothing for Sillage to show.
  'experimental.push.',
  'session.status', 'session.idle', 'V2Event.',
]

/** Text or reasoning being written, keyed by message, kind and ordinal. */
interface OpenText {
  kind: 'text' | 'thinking'
  text: string
  sessionId: string
  parent: string | null
}

/** Reported tool state, to journal changes only. */
interface ToolTrack {
  tool: string
  input: unknown
  inputJson: string
  startedAt: number
}

interface ShellOutput {
  output: string
  cursor: number
  size: number
  truncated: boolean
}

interface ShellReader {
  cursor: number
  timer: NodeJS.Timeout | null
  reading: boolean
}

type Usage = { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }
const NO_USAGE: Usage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const USAGE_FIELDS = Object.keys(NO_USAGE) as (keyof Usage)[]

/** Like the step counters: `output` includes reasoning, `input` excludes cache. */
function usageOf(tokens: TokenUsage, cost: number): Usage {
  return { cost, input: tokens.input, output: tokens.output + tokens.reasoning, cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write }
}

/** Cumulative usage opencode last reported for a session, and step usage it did not include yet. */
interface SessionTotals { reported: Usage; unreported: Usage }

function boundedAdd(set: Set<string>, value: string, max = 4096): void {
  set.add(value)
  if (set.size > max) set.delete(set.values().next().value!)
}

export class Opencode2Runner implements AgentRunner {
  readonly conversationId: string

  private server: OpencodeServer<Event> | null = null
  private sessionId: string | null = null
  private config: OpencodeConfig
  private launched: Opencode2Config | null = null
  private mcpServers: McpServer[] = []
  private mcpFailures: McpServerStatus[] = []
  private lastMcpPayload: string | null = null
  private readonly interactions: PendingInteractions
  /** Native request (per_…, frm_…) mapped to Sillage request ID and the session asking. */
  private readonly nativeRequests = new Map<string, { requestId: string; sessionId: string }>()
  /** "Allow for the session" approvals, held by Sillage for this conversation's lifetime. */
  private readonly sessionGrants = new SessionGrants()
  /** Requests opencode closed itself, requiring no answer. */
  private readonly settledNatively = new Set<string>()

  private readonly texts = new Map<string, OpenText>()
  private readonly closedTexts = new Set<string>()
  private readonly tools = new Map<string, ToolTrack>()
  private readonly closedTools = new Set<string>()
  /** Session of each open call, so a closing turn only aborts its own. */
  private readonly toolSession = new Map<string, string>()
  /** Shell behind a call, for live output and to link a background shell job to its call. */
  private readonly shellCalls = new Map<string, string>()
  /** Live output readers of running shell calls, by call. */
  private readonly shellReaders = new Map<string, ShellReader>()
  /** Skill IDs offered to the composer, the only ones attached to prompts. */
  private skillIds = new Set<string>()
  /** Question tool calls: the form replaces their card. */
  private readonly hiddenTools = new Set<string>()
  /** Subagent session mapped to its launching call, null until the call names it. */
  private readonly children = new Map<string, string | null>()
  /** Background jobs still running, in launch order. */
  private readonly jobs = new Map<string, BackgroundTask>()
  /** Subagent reports delivered to the parent's inbox, by child session, until the job closes. */
  private readonly reports = new Map<string, string>()
  /** Model of each assistant message, for the context gauge. */
  private readonly assistantModels = new Map<string, string>()
  private readonly noticed = new Set<string>()

  private readonly turn: TurnLifecycle
  /** Usage since the last `turn.completed`: background subagents spend between parent turns. */
  private usage: Usage = { ...NO_USAGE }
  /** Per session of the tree, to find spending without steps (compaction, titles). */
  private readonly sessionTotals = new Map<string, SessionTotals>()
  private turnAborted = false
  private turnFailed = false
  private compacting = false
  private lastAssistantMessageId: string | null = null

  private readonly contextLimits = new Map<string, number>()
  private defaultModel: string | null = null
  private commandNames = new Set<string>()
  /** Session state last set, null when unknown (fresh runner on a resumed session). */
  private applied: { model: string | null; agent: string | null; instructions: string | null | undefined } = {
    model: null, agent: null, instructions: undefined,
  }
  private reloadPending = false
  /** Replaying a stored session rather than running one. */
  private importing = false
  private reloading: Promise<void> | null = null
  private suggested: string | null = null

  get appliedConfig(): AgentConfig {
    return this.config
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as OpencodeConfig
    const interactions = new PendingInteractions(ctx)
    this.interactions = interactions
    // A turn closing expires what it asked, not what background subagents ask meanwhile.
    this.turn = new TurnLifecycle(ctx, {
      get hasBlocking() { return interactions.hasBlocking },
      expireAll: () => this.expireRequestsOf(this.sessionId),
    })
  }

  private launchConfig(config: OpencodeConfig): { launch: Opencode2Config; servers: McpServer[]; failures: McpServerStatus[] } {
    const resolved = this.ctx.resolveMcpServers(config)
    const memoryDir = this.ctx.memoryDir()
    return {
      launch: toOpencode2Config({
        config,
        mcpServers: resolved.servers,
        skillRoots: this.ctx.skillRoots(config),
        readableDirs: [this.ctx.attachmentsRoot, ...(memoryDir ? [memoryDir] : []), ...(this.ctx.mediaDir ? [this.ctx.mediaDir] : [])],
      }),
      servers: resolved.servers,
      failures: failedStatuses(resolved.failures),
    }
  }

  /**
   * Adopt a session begun outside Sillage: replay its stored messages into the journal without
   * any model request. The manager stops the runner afterwards; the next message resumes it.
   */
  async importHistory(): Promise<void> {
    this.importing = true
    try {
      await this.start()
      const server = this.server!
      const sessionId = this.sessionId!
      const messages: MessageInfo[] = []
      for await (const page of historyPages((path) => server.get(path), sessionId)) messages.push(...page)
      for (const { event, raw } of historyEvents(sessionId, messages, this.ctx.cwd, this.mcpServers.map((server) => server.name))) {
        this.ctx.emit(event, raw)
      }
      this.ctx.setStatus('idle')
    } finally {
      this.importing = false
    }
  }

  async start(): Promise<void> {
    const { launch, servers, failures } = this.launchConfig(this.config)
    this.launched = launch
    this.mcpServers = servers
    this.mcpFailures = failures

    // Same reason as 1.x: SILLAGE.md arrives as an instruction entry, the repository's AGENTS.md
    // would duplicate it. 2.x still honours the variable (probed 2.4.1).
    const masked = this.ctx.maskedInstructionRoots().length > 0
    this.server = await OpencodeServer.start<Event>({
      generation: 2,
      binary: this.ctx.binary,
      cwd: this.ctx.cwd,
      env: agentProcessEnv({
        ...this.ctx.processEnv,
        ...(masked ? { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } : {}),
      }),
      config: launch,
      onEvent: (event) => {
        try { this.translate(event) }
        catch (error) {
          this.notice('translation_failed', `Impossible de lire l'événement opencode ${event.type} : ${error instanceof Error ? error.message : String(error)}`, 'warning', event)
        }
      },
      onReconnect: () => detach(this.resync(), 'opencode resync after reconnect'),
      onExit: (code) => this.onProcessExit(code),
    })

    // Sessions live in the opencode database; 1.x sessions were migrated there with their IDs on
    // the first 2.x start, so a conversation begun on 1.x resumes here (probed 2.4.1).
    const session = this.ctx.resumeSessionId
      ? (await this.server.get<{ data: SessionInfo }>(`/api/session/${this.ctx.resumeSessionId}`)).data
      : (await this.server.post<{ data: SessionInfo }>('/api/session', { location: { directory: this.ctx.cwd } })).data

    await this.loadCatalog(START_MODELS_FILL_MS)

    this.sessionId = session.id
    // A resumed session's earlier spending was counted by the runs that made it.
    this.sessionTotals.set(session.id, { reported: usageOf(session.tokens, session.cost), unreported: { ...NO_USAGE } })
    this.ctx.setAgentSessionId(session.id)
    this.ctx.emit(
      {
        type: 'session.started',
        agent: 'opencode',
        agentSessionId: session.id,
        model: this.config.model || this.defaultModel || '',
        cwd: session.location?.directory ?? this.ctx.cwd,
        tools: [],
      },
      session,
    )
    // Background jobs belong to the server process: a previous one's died with it.
    this.ctx.emit({ type: 'background.updated', tasks: [] })
    // An import only replays the stored history: inventories belong to the live session after it.
    if (this.importing) return
    detach(this.publishMcpStatus(), 'MCP status publication')
    detach(this.publishCommands(), 'slash command publication')
  }

  /**
   * Context windows and the default model, absent from the stream. A fresh server lists no model
   * for about a second: wait briefly at start, and read again on `models-dev.refreshed`.
   */
  private async loadCatalog(fillMs = 0): Promise<void> {
    const server = this.server
    if (!server) return
    try {
      const [data, fallback] = await Promise.all([
        readModels2(server, fillMs),
        server.get<{ data: ModelRef | null }>('/api/model/default'),
      ])
      for (const model of data) this.contextLimits.set(`${model.providerID}/${model.id}`, model.limit.context)
      const first = data.find((model) => model.enabled)
      this.defaultModel = fallback.data
        ? `${fallback.data.providerID}/${fallback.data.id}`
        : first ? `${first.providerID}/${first.id}` : null
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] catalogue indisponible : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  private async publishMcpStatus(): Promise<void> {
    const server = this.server
    if (!server) return
    try {
      const { data } = await server.get<{ data: NativeMcpServer[] }>('/api/mcp')
      const servers = [...this.mcpFailures, ...fromOpencode2McpStatus(data, this.mcpServers)]
      const payload = JSON.stringify(servers)
      if (payload === this.lastMcpPayload) return
      this.lastMcpPayload = payload
      this.ctx.emit({ type: 'mcp.updated', servers })
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] inventaire MCP indisponible : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  /**
   * Slash commands and skills. Both load lazily after the first request and no event announces
   * them (see catalog.ts): read until filled. Skills are no longer commands on 2.x; they are
   * offered like Codex's `$` skills and attached to the prompt.
   */
  private async publishCommands(): Promise<void> {
    const server = this.server
    if (!server) return
    try {
      const [native, skills] = await Promise.all([readCommands2(server), readSkills2(server)])
      if (server !== this.server) return
      const commands = usableSlashCommands(toSlashCommands2(native))
      this.commandNames = new Set(commands.map((command) => command.name))
      this.ctx.emit({ type: 'commands.updated', commands })
      const published = toAgentSkills(skills)
      this.skillIds = new Set(published.map((skill) => skill.name))
      this.ctx.emit({ type: 'skills.updated', skills: published })
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] commandes indisponibles : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  private onProcessExit(code: number | null): void {
    this.server = null
    this.turn.abandon()
    if (!this.sessionId) return
    this.interactions.expireAll()
    this.ctx.setStatus('error')
    journalDeath(this.ctx, {
      type: 'error',
      code: 'runner_failed',
      message: `opencode serve stopped unexpectedly (code ${code ?? 'unknown'}).`,
      recoverable: true,
    })
  }

  /** After a stream gap the turn may have ended unheard: active sessions are listed, idle ones absent. */
  private async resync(): Promise<void> {
    if (!this.server || !this.sessionId) return
    try {
      const { data } = await this.server.get<{ data: Record<string, unknown> }>('/api/session/active')
      if (this.turn.open && !(this.sessionId in data)) this.endTurn()
    } catch {
      // The reconnected stream reports what follows.
    }
  }

  private inTree(sessionId: string | undefined): sessionId is string {
    return sessionId !== undefined && (sessionId === this.sessionId || this.children.has(sessionId))
  }

  /** Launching subagent call of a session, null for the main one. */
  private parentOf(sessionId: string): string | null {
    return sessionId === this.sessionId ? null : (this.children.get(sessionId) ?? null)
  }

  private isRoot(sessionId: string | undefined): boolean {
    return sessionId !== undefined && sessionId === this.sessionId
  }

  private translate(event: Event): void {
    switch (event.type) {
      case 'session.created': {
        const { sessionID, parentID } = event.data
        if (parentID && this.inTree(parentID) && !this.children.has(sessionID)) this.children.set(sessionID, null)
        return
      }
      case 'session.renamed':
        if (this.isRoot(event.data.sessionID) && event.data.title) this.suggested = event.data.title
        return

      case 'session.execution.started':
        if (this.isRoot(event.data.sessionID)) this.beginTurn()
        return
      case 'session.execution.succeeded':
        if (this.isRoot(event.data.sessionID)) this.endTurn()
        return
      case 'session.execution.failed':
        if (!this.isRoot(event.data.sessionID)) return
        this.reportError(event.data.error, event)
        this.endTurn()
        return
      case 'session.execution.interrupted':
        if (!this.isRoot(event.data.sessionID)) return
        this.turnAborted = true
        this.endTurn()
        return

      case 'session.step.started':
        if (!this.inTree(event.data.sessionID)) return
        this.rememberModel(event.data.assistantMessageID, event.data.model)
        if (this.isRoot(event.data.sessionID)) this.lastAssistantMessageId = event.data.assistantMessageID
        return
      case 'session.step.ended':
        if (this.inTree(event.data.sessionID)) this.onStepUsage(event.data.sessionID, event.data.assistantMessageID, event.data.tokens, event.data.cost)
        return
      case 'session.step.failed':
        if (!this.inTree(event.data.sessionID)) return
        if (event.data.tokens) this.onStepUsage(event.data.sessionID, event.data.assistantMessageID, event.data.tokens, event.data.cost ?? 0)
        if (this.isRoot(event.data.sessionID)) this.reportError(event.data.error, event)
        return
      case 'session.retry.scheduled':
        if (!this.isRoot(event.data.sessionID)) return
        this.notice('retry', `opencode réessaie (tentative ${event.data.attempt}) : ${event.data.error.message}`, 'info', event, `opencode-retry:${this.sessionId}`)
        return

      case 'session.text.started':
      case 'session.reasoning.started':
        this.openText(event.data.sessionID, textKey(event.data.assistantMessageID, event.type, event.data.ordinal), event.type === 'session.text.started' ? 'text' : 'thinking')
        return
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const kind = event.type === 'session.text.delta' ? 'text' : 'thinking'
        const key = textKey(event.data.assistantMessageID, event.type, event.data.ordinal)
        const open = this.openText(event.data.sessionID, key, kind)
        if (!open) return
        open.text += event.data.delta
        this.ctx.emit({ type: kind === 'text' ? 'message.delta' : 'thinking.delta', messageId: key, text: event.data.delta, parentToolCallId: open.parent })
        return
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const kind = event.type === 'session.text.ended' ? 'text' : 'thinking'
        const key = textKey(event.data.assistantMessageID, event.type, event.data.ordinal)
        const open = this.openText(event.data.sessionID, key, kind)
        if (!open) return
        this.closeText(key, event.data.text, event)
        return
      }

      case 'session.tool.input.started':
        if (!this.inTree(event.data.sessionID)) return
        this.startTool(event.data.id, event.data.name, {}, event.data.sessionID, event.created, event)
        return
      case 'session.tool.input.ended': {
        if (!this.inTree(event.data.sessionID)) return
        let input: unknown = {}
        try { input = JSON.parse(event.data.text) } catch { return }
        this.updateToolInput(event.data.id, input, event)
        return
      }
      case 'session.tool.called': {
        if (!this.inTree(event.data.sessionID)) return
        const track = this.tools.get(event.data.id)
        // Calls the model wrote without streaming their input arrive here first.
        if (!track) {
          const name = (event.data as { name?: unknown }).name
          if (typeof name === 'string') this.startTool(event.data.id, name, event.data.input, event.data.sessionID, event.created, event)
        } else {
          track.startedAt = event.created
          this.updateToolInput(event.data.id, event.data.input, event)
        }
        return
      }
      case 'session.tool.progress':
        if (!this.inTree(event.data.sessionID)) return
        this.linkChild(event.data.id, event.data.metadata)
        this.followShell(event.data.id, event.data.metadata)
        return
      case 'session.tool.success':
        if (!this.inTree(event.data.sessionID)) return
        this.linkChild(event.data.id, event.data.metadata)
        this.completeTool(event.data.id, contentText(event.data.content), false, event.data.metadata, event.created, event)
        return
      case 'session.tool.failed': {
        if (!this.inTree(event.data.sessionID)) return
        const detail = contentText(event.data.content)
        this.completeTool(event.data.id, detail || event.data.error.message, true, event.data.metadata, event.created, event)
        return
      }

      case 'permission.asked':
        this.onPermissionAsked(event.data)
        return
      case 'permission.replied':
        this.settle(event.data.requestID)
        return
      case 'form.created':
        this.onFormCreated(event.data.form)
        return
      case 'form.replied':
      case 'form.cancelled':
        this.settle(event.data.id)
        return

      case 'experimental.job.updated':
        this.onJob(event.data.info)
        return
      case 'session.inbox.enqueued':
        this.rememberReport(event.data)
        return

      case 'session.usage.updated':
        if (this.inTree(event.data.sessionID)) this.onSessionUsage(event.data.sessionID, usageOf(event.data.tokens, event.data.cost))
        return

      case 'session.compaction.started':
        if (!this.isRoot(event.data.sessionID) || this.compacting) return
        this.compacting = true
        this.ctx.emit({ type: 'context.compaction_started' })
        return
      case 'session.compaction.ended':
        if (!this.isRoot(event.data.sessionID)) return
        this.compacting = false
        this.ctx.emit({ type: 'context.compacted', trigger: event.data.reason, preTokens: null, postTokens: null }, event)
        return
      case 'session.compaction.failed':
        if (!this.isRoot(event.data.sessionID)) return
        this.compacting = false
        this.notice('compaction_failed', `La compaction a échoué : ${event.data.error.message}`, 'warning', event)
        return

      case 'models-dev.refreshed':
        detach(this.loadCatalog(), 'opencode model catalog')
        return
      case 'mcp.status.changed':
        detach(this.publishMcpStatus(), 'MCP status publication')
        return
      case 'command.updated':
      case 'skill.updated':
        detach(this.publishCommands(), 'slash command publication')
        return

      default: {
        const type: string = event.type
        if (NOISE.some((prefix) => type.startsWith(prefix))) return
        if (this.noticed.has(type)) return
        this.noticed.add(type)
        this.notice(type, `Événement opencode : ${type}`, 'info', event, `opencode-notice:${type}`)
      }
    }
  }

  private notice(code: string, message: string, level: 'info' | 'warning', details?: unknown, id?: string): void {
    this.ctx.emit({ type: 'agent.notice', id, code, message, level, details }, details)
  }

  private beginTurn(): void {
    if (this.turn.open) return
    this.turnAborted = false
    this.turnFailed = false
    this.turn.begin()
  }

  private endTurn(): void {
    const usage = this.usage
    const closed = this.turn.end({
      stopReason: this.turnAborted ? 'interrupted' : this.turnFailed ? 'failed' : 'completed',
      usage: {
        costUsd: usage.cost,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheCreationTokens: usage.cacheWrite,
      },
      // Last root assistant message gives forks their cut.
      raw: { sessionID: this.sessionId, messageID: this.lastAssistantMessageId },
      close: () => {
        // Root output stops with the turn; background subagents keep writing theirs.
        for (const [key, open] of [...this.texts]) if (open.sessionId === this.sessionId) this.closeText(key)
        for (const [id] of [...this.tools]) {
          if (this.toolSession.get(id) !== this.sessionId) continue
          this.stopShellReader(id)
          this.tools.delete(id)
          boundedAdd(this.closedTools, id)
          this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: 'Tool execution aborted', isError: true, durationMs: 0 })
        }
        this.compacting = false
      },
    })
    if (!closed) return
    this.usage = { ...NO_USAGE }
    // A subagent may still be waiting on the user while the parent rests.
    if (this.interactions.hasBlocking) this.ctx.setStatus('awaiting_input')
    if (this.reloadPending) detach(this.reloadInstance(), 'opencode location reload')
  }

  private reportError(error: StructuredError, raw: unknown): void {
    // An interruption is not a failure, though 2.x reports it on the step.
    if (error.type === 'aborted' || error.type === 'MessageAbortedError') {
      this.turnAborted = true
      return
    }
    if (this.turnFailed) return
    this.turnFailed = true
    this.ctx.emit({ type: 'error', code: opencodeErrorCode(error.type), message: error.message || error.type, recoverable: true }, raw)
  }

  private rememberModel(messageId: string, model: ModelRef | undefined): void {
    if (!model) return
    this.assistantModels.set(messageId, `${model.providerID}/${model.id}`)
    if (this.assistantModels.size > 256) this.assistantModels.delete(this.assistantModels.keys().next().value!)
  }

  private totalsOf(sessionId: string): SessionTotals {
    let totals = this.sessionTotals.get(sessionId)
    // Children are new sessions: they start from zero.
    if (!totals) this.sessionTotals.set(sessionId, totals = { reported: { ...NO_USAGE }, unreported: { ...NO_USAGE } })
    return totals
  }

  /** Step usage. Like 1.x, `input` excludes cache: context occupancy sums all three. */
  private onStepUsage(sessionId: string, messageId: string, tokens: TokenUsage, cost: number): void {
    const step = usageOf(tokens, cost)
    const { unreported } = this.totalsOf(sessionId)
    for (const field of USAGE_FIELDS) {
      this.usage[field] += step[field]
      unreported[field] += step[field]
    }

    const used = tokens.input + tokens.cache.read + tokens.cache.write
    const model = this.isRoot(sessionId) ? this.assistantModels.get(messageId) : undefined
    const limit = model ? this.contextLimits.get(model) : undefined
    this.ctx.emit({
      type: 'usage.updated',
      costUsd: cost,
      inputTokens: tokens.input,
      outputTokens: tokens.output + tokens.reasoning,
      context: limit && used > 0 ? { usedTokens: used, maxTokens: limit, ratio: used / limit } : null,
      rateLimit: null,
    })
  }

  /**
   * `session.usage.updated` carries a session's running total (probed 2.4.2). Steps stay the
   * source of the counters: each one is reported right after its `step.ended`, so only the part
   * of the increase no step explains is added. That is spending without steps: a compaction,
   * counted in its turn, and the title, generated just after the execution ends and then
   * reported on its own.
   */
  private onSessionUsage(sessionId: string, total: Usage): void {
    const totals = this.totalsOf(sessionId)
    const extra = { ...NO_USAGE }
    for (const field of USAGE_FIELDS) {
      // A total going down (a revert) adds nothing; float noise in costs is not spending.
      const increase = Math.max(0, total[field] - totals.reported[field])
      const explained = Math.min(increase, totals.unreported[field])
      totals.unreported[field] -= explained
      extra[field] = increase - explained < 1e-9 ? 0 : increase - explained
    }
    totals.reported = total
    if (USAGE_FIELDS.every((field) => extra[field] === 0)) return
    if (this.turn.open) {
      for (const field of USAGE_FIELDS) this.usage[field] += extra[field]
      return
    }
    this.ctx.emit({
      type: 'usage.consumed',
      model: null,
      costUsd: extra.cost,
      inputTokens: extra.input,
      outputTokens: extra.output,
      cacheReadTokens: extra.cacheRead,
      cacheCreationTokens: extra.cacheWrite,
    }, { sessionID: sessionId, tokens: total })
  }

  private openText(sessionId: string, key: string, kind: OpenText['kind']): OpenText | null {
    if (!this.inTree(sessionId) || this.closedTexts.has(key)) return null
    let open = this.texts.get(key)
    if (!open) {
      open = { kind, text: '', sessionId, parent: this.parentOf(sessionId) }
      this.texts.set(key, open)
    }
    return open
  }

  /** `final` is authoritative: a suffix the deltas missed becomes a catch-up delta. */
  private closeText(key: string, final?: string, raw?: unknown): void {
    const open = this.texts.get(key)
    if (!open) return
    if (final !== undefined && final.length > open.text.length && final.startsWith(open.text)) {
      this.ctx.emit({ type: open.kind === 'text' ? 'message.delta' : 'thinking.delta', messageId: key, text: final.slice(open.text.length), parentToolCallId: open.parent })
    }
    const text = final ?? open.text
    this.texts.delete(key)
    boundedAdd(this.closedTexts, key)
    // Provider-hidden reasoning arrives empty: nothing to show.
    if (!text.trim()) return
    this.ctx.emit({ type: 'message.completed', messageId: key, role: 'assistant', blocks: [{ type: open.kind, text }], parentToolCallId: open.parent }, raw)
  }

  private startTool(id: string, tool: string, input: unknown, sessionId: string, at: number, raw: unknown): void {
    if (tool === QUESTION_TOOL) {
      boundedAdd(this.hiddenTools, id)
      return
    }
    if (this.tools.has(id) || this.closedTools.has(id)) return
    const described = describeTool(tool, input, this.mcpServers.map((server) => server.name))
    this.tools.set(id, { tool, input, inputJson: JSON.stringify(described.input), startedAt: at })
    this.toolSession.set(id, sessionId)
    this.ctx.emit({ type: 'tool.started', toolCallId: id, ...described, presentation: {}, parentToolCallId: this.parentOf(sessionId) }, raw)
  }

  private updateToolInput(id: string, input: unknown, raw: unknown): void {
    const track = this.tools.get(id)
    if (!track) return
    const described = describeTool(track.tool, input, this.mcpServers.map((server) => server.name))
    const json = JSON.stringify(described.input)
    track.input = input
    if (json === track.inputJson) return
    track.inputJson = json
    this.ctx.emit({ type: 'tool.input_updated', toolCallId: id, input: described.input }, raw)
  }

  /** Subagent calls name their child session in metadata (`session.tool.progress`, then success). */
  private linkChild(callId: string, metadata: unknown): void {
    const sessionId = (metadata as { sessionID?: unknown } | undefined)?.sessionID
    if (typeof sessionId !== 'string') return
    if (this.tools.get(callId)?.tool !== SUBAGENT_TOOL && !this.closedTools.has(callId)) return
    this.children.set(sessionId, callId)
  }

  private completeTool(id: string, output: string, isError: boolean, metadata: unknown, at: number, raw: object): void {
    if (this.hiddenTools.has(id)) return
    const track = this.tools.get(id)
    if (!track) return
    this.stopShellReader(id)
    this.tools.delete(id)
    this.toolSession.delete(id)
    boundedAdd(this.closedTools, id)
    const call: CompletedCall = { tool: track.tool, input: track.input, metadata, output }
    this.ctx.emit({ type: 'tool.completed', toolCallId: id, output, isError, durationMs: Math.max(0, at - track.startedAt) }, { ...raw, call })
    if (!isError) for (const edit of fileEdits(id, call, this.ctx.cwd)) this.ctx.emit(edit)
  }

  private onPermissionAsked(request: EventData<'permission.asked'>): void {
    if (!this.inTree(request.sessionID) || this.nativeRequests.has(request.id)) return
    const path = `/api/session/${request.sessionID}/permission/${request.id}/reply`
    if (this.sessionGrants.covers(request.action, request.resources)) {
      this.reply('POST', path, { decision: 'once' satisfies PermissionReply })
      return
    }
    const details = describePermission(request.action, request.resources, request.metadata, this.ctx.cwd)
    const requestId = this.interactions.requestPermission(details, (decision) => {
      this.nativeRequests.delete(request.id)
      if (this.settledNatively.delete(request.id)) return
      // Never `always`: 2.x would save a widened, permanent project rule (see permissions.ts).
      const allowed = decision?.decision === 'allowed'
      if (allowed && decision.scope !== 'once') this.sessionGrants.grant(request.action, request.resources, request.save)
      const reply: PermissionReply = allowed ? 'once' : 'reject'
      this.reply('POST', path, { decision: reply })
    })
    this.nativeRequests.set(request.id, { requestId, sessionId: request.sessionID })
  }

  private onFormCreated(form: FormInfo): void {
    if (!this.inTree(form.sessionID) || this.nativeRequests.has(form.id)) return
    const path = `/api/session/${form.sessionID}/form/${form.id}`
    const answer = (body: FormAnswer | null) => {
      this.nativeRequests.delete(form.id)
      if (this.settledNatively.delete(form.id)) return
      // Dismissing a question form ends the tool, then the turn, like rejecting a 1.x question.
      if (body) this.reply('POST', `${path}/reply`, { answer: body })
      else this.reply('DELETE', path)
    }
    const requestId = isQuestionForm(form)
      ? this.interactions.requestQuestion(formQuestions(form), (reply) =>
          answer(reply?.status === 'answered' ? questionAnswer(form, reply) : null))
      : this.interactions.requestElicitation(formElicitation(form), (reply) =>
          answer(reply?.action === 'accept' ? elicitationAnswer(reply) : null))
    this.nativeRequests.set(form.id, { requestId, sessionId: form.sessionID })
  }

  /** opencode closed a request itself (another client, an interruption): no answer expected. */
  private settle(nativeId: string): void {
    const request = this.nativeRequests.get(nativeId)
    if (!request) return
    this.settledNatively.add(nativeId)
    this.interactions.expire(request.requestId)
    if (this.turn.open) this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
  }

  /** Expire the requests a session asked; null expires nothing. */
  private expireRequestsOf(sessionId: string | null): void {
    if (!sessionId) return
    for (const [nativeId, request] of [...this.nativeRequests]) {
      if (request.sessionId !== sessionId) continue
      this.settledNatively.add(nativeId)
      this.interactions.expire(request.requestId)
      this.nativeRequests.delete(nativeId)
    }
  }

  private reply(method: 'POST' | 'DELETE', path: string, body?: unknown): void {
    const server = this.server
    if (!server) return
    server.request(method, path, body).catch((err: unknown) => {
      process.stderr.write(`[opencode ${this.conversationId}] réponse refusée sur ${path} : ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }

  /**
   * A background job's report reaches its parent as a synthetic inbox item, just before the job
   * closes (probed 2.4.1): `<background-result kind="subagent" sessionID="ses_…" …>report…` for a
   * subagent, whose job ID is its session, `<background-result kind="shell" id="sh_…" …>output…`
   * for a shell, whose job ID is the shell. Kept by job ID until the job closes.
   */
  private rememberReport(data: EventData<'session.inbox.enqueued'>): void {
    const item = data.item as { type?: unknown; payload?: { text?: unknown } }
    if (item.type !== 'synthetic' || typeof item.payload?.text !== 'string') return
    const match = /^<background-result\b([^>]*)>\n?([\s\S]*?)\n?<\/background-result>/.exec(item.payload.text)
    if (!match) return
    const attributes = match[1] ?? ''
    const id = /\bsessionID="([^"]+)"/.exec(attributes)?.[1] ?? /\bid="([^"]+)"/.exec(attributes)?.[1]
    if (id && this.jobs.has(id)) this.reports.set(id, match[2] ?? '')
  }

  private onJob(job: JobInfo): void {
    if (!this.inTree(job.sessionID)) return
    const known = this.jobs.has(job.id)
    if (job.status === 'running') {
      if (known) return
      const task = { id: job.id, kind: jobKind(job), description: jobDescription(job) }
      this.jobs.set(job.id, task)
      this.ctx.emit({
        type: 'task.started',
        taskId: job.id,
        toolCallId: job.kind === 'subagent' ? (this.children.get(job.childSessionID) ?? null)
          : job.kind === 'shell' ? (this.callOfShell(job.shellID) ?? null) : null,
        kind: task.kind,
        description: task.description,
        workflowName: null,
      }, job)
    } else {
      if (!known) return
      this.jobs.delete(job.id)
      const summary = this.reports.get(job.id) ?? ''
      this.reports.delete(job.id)
      this.ctx.emit({
        type: 'task.completed',
        taskId: job.id,
        status: job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'stopped' : 'failed',
        summary,
        durationMs: job.time.completed ? Math.max(0, job.time.completed - job.time.started) : null,
        ambient: false,
      }, job)
    }
    this.ctx.emit({ type: 'background.updated', tasks: [...this.jobs.values()] })
  }

  /** Bring the session's durable model, agent and instructions to the conversation's. */
  private async syncSession(): Promise<void> {
    const server = this.server!
    const base = `/api/session/${this.sessionId}`
    // The model is durable: going back to "CLI default" must name the default, or the session
    // would keep the last model chosen.
    const parsed = parseModel(this.config.model) ?? (this.applied.model !== null ? parseModel(this.defaultModel ?? '') : null)
    if (parsed) {
      const model: ModelRef = { providerID: parsed.providerID, id: parsed.modelID, ...(this.config.variant ? { variant: this.config.variant } : {}) }
      const key = JSON.stringify(model)
      if (key !== this.applied.model) {
        await server.post(`${base}/model`, { model })
        this.applied.model = key
      }
    }
    if (this.config.primaryAgent && this.config.primaryAgent !== this.applied.agent) {
      await server.post(`${base}/agent`, { agent: this.config.primaryAgent })
      this.applied.agent = this.config.primaryAgent
    }
    // A durable entry, applied at the next step: no need to resend it with every message.
    const instructions = this.ctx.projectOverview(this.config)
    if (instructions !== this.applied.instructions) {
      const entry = `/api/experimental/session/${this.sessionId}/instructions/entries/${INSTRUCTIONS_KEY}`
      if (instructions) await server.request('PUT', entry, { value: instructions })
      else if (this.applied.instructions !== null) await server.request('DELETE', entry).catch(() => {})
      this.applied.instructions = instructions
    }
  }

  /** Mentions and inline images travel as file URIs, which opencode reads and inlines itself. */
  private files(attachments: OutgoingAttachment[], mentions: OutgoingMention[]): FileAttachment[] {
    return [
      ...mentions.map((mention) => ({ uri: pathToFileURL(mention.path).href, name: mention.relativePath })),
      ...attachments.filter((attachment) => attachment.inlineImage).map((attachment) => ({ uri: pathToFileURL(attachment.path).href, name: attachment.filename })),
    ]
  }

  /**
   * Sub-agents the text @-mentions, read from this directory's agents so project agents count
   * too. Only the text reaches the model; the attachment records which agent it names, as the
   * TUI does (2.4.2). Nothing is added when the text names none.
   */
  private async agentsOf(text: string, mentions: OutgoingMention[]): Promise<{ agents?: AgentMention[] }> {
    if (!this.server || !text.includes('@')) return {}
    try {
      const names = (await readAgents2(this.server, 0)).filter((agent) => agent.mode !== 'primary' && !agent.hidden).map((agent) => agent.id)
      const agents = agentMentions(text, names, mentions.map((mention) => mention.relativePath))
      return agents.length ? { agents } : {}
    } catch {
      // A hint only: the message leaves without it.
      return {}
    }
  }

  /** Skills picked in the composer, by ID; unknown names are ignored like every runner does. */
  private skillsOf(names: string[]): { id: string }[] {
    return names.filter((name) => this.skillIds.has(name)).map((id) => ({ id }))
  }

  async send(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[] = []): Promise<void> {
    if (!this.server || !this.sessionId) throw new Error("La session opencode n'est pas démarrée.")
    const { promptText } = describeOutgoingMessage(text, attachments, this.ctx.sessionReferenceContext?.(text, this.appliedConfig))
    this.ctx.setStatus('running')
    if (this.reloading) await this.reloading
    if (!this.server) throw new Error('La session opencode est fermée.')

    try {
      await this.syncSession()
      const command = parseSlashCommand(text)
      if (command && this.commandNames.has(command.name)) {
        this.runCommand(command.name, command.args)
      } else {
        await this.server.post(`/api/session/${this.sessionId}/prompt`, { text: promptText, files: this.files(attachments, mentions), skills: this.skillsOf(skills), ...await this.agentsOf(promptText, mentions) })
      }
    } catch (error) {
      if (!this.turn.open && this.server) this.ctx.setStatus('idle')
      throw error
    }
  }

  /**
   * Fired without awaiting, like 1.x whose route answered only at turn end: the stream reports the
   * execution either way, and a failure is journaled.
   */
  private runCommand(name: string, args: string): void {
    this.server!.post(`/api/session/${this.sessionId}/command`, { name, text: args }, null).catch((err: unknown) => {
      if (!this.server) return
      this.ctx.emit({ type: 'error', code: 'turn_failed', message: err instanceof Error ? err.message : String(err), recoverable: true })
      if (!this.turn.open) this.ctx.setStatus('idle')
    })
  }

  /** 2.x prompts steer by default: taken at the next step boundary of the running execution. */
  async steer(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[] = []): Promise<boolean> {
    if (!this.server || !this.sessionId || !this.turn.open) return false
    const { blocks, promptText } = describeOutgoingMessage(text, attachments, this.ctx.sessionReferenceContext?.(text, this.appliedConfig), { mentions, skills: this.skillsOf(skills).map((skill) => skill.id) })
    await this.server.post(`/api/session/${this.sessionId}/prompt`, { text: promptText, files: this.files(attachments, mentions), skills: this.skillsOf(skills), ...await this.agentsOf(promptText, mentions), delivery: 'steer' })
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    return true
  }

  /** 2.x admits the request durably and answers at once; the stream reports the compaction. */
  async compact(): Promise<boolean> {
    if (!this.server || !this.sessionId) return false
    await this.server.post(`/api/session/${this.sessionId}/compact`, {})
    return true
  }

  async stopBackgroundTask(taskId: string): Promise<boolean> {
    if (!this.server || !this.jobs.has(taskId)) return false
    try {
      await this.server.post(`/api/experimental/job/${encodeURIComponent(taskId)}/cancel`)
    } catch {
      return false
    }
    return true
  }

  /**
   * The last 8 KiB a background shell wrote, like Claude's task output. Read from the shell's
   * captured output by byte cursor; subagents have no output of this kind.
   */
  async readBackgroundTaskOutput(taskId: string): Promise<BackgroundTaskOutput | null> {
    const server = this.server
    if (!server || !taskId.startsWith('sh_')) return null
    try {
      const path = `/api/shell/${encodeURIComponent(taskId)}/output`
      const { data: head } = await server.get<{ data: ShellOutput }>(`${path}?cursor=0&limit=1`)
      const start = Math.max(0, head.size - BACKGROUND_OUTPUT_BYTES)
      const { data } = await server.get<{ data: ShellOutput }>(`${path}?cursor=${start}&limit=${BACKGROUND_OUTPUT_BYTES}`)
      return { output: data.output, totalBytes: data.size, truncated: start > 0 }
    } catch {
      // Output removed with its shell, or never captured.
      return null
    }
  }

  private callOfShell(shellId: string): string | undefined {
    for (const [callId, shell] of this.shellCalls) if (shell === shellId) return callId
    return undefined
  }

  /**
   * Live output of a running shell call. 2.x no longer streams it in the call's metadata: the call
   * names its shell (`metadata.shellID`), whose captured output pages by byte cursor (probed
   * 2.4.1). Read while the call runs; its result carries the complete output.
   */
  private followShell(callId: string, metadata: unknown): void {
    const shellId = (metadata as { shellID?: unknown } | undefined)?.shellID
    if (typeof shellId !== 'string' || !this.tools.has(callId) || this.shellReaders.has(callId)) return
    this.shellCalls.set(callId, shellId)
    if (this.shellCalls.size > 256) this.shellCalls.delete(this.shellCalls.keys().next().value!)
    const reader: ShellReader = { cursor: 0, timer: null, reading: false }
    this.shellReaders.set(callId, reader)
    const read = async () => {
      const server = this.server
      if (!server || reader.reading || this.shellReaders.get(callId) !== reader) return
      reader.reading = true
      try {
        const { data } = await server.get<{ data: ShellOutput }>(`/api/shell/${encodeURIComponent(shellId)}/output?cursor=${reader.cursor}`)
        // A reader stopped meanwhile must not write after the call's completion.
        if (data.output && this.shellReaders.get(callId) === reader) {
          this.ctx.emit({ type: 'tool.output_delta', toolCallId: callId, chunk: data.output })
        }
        reader.cursor = data.cursor
      } catch {
        // Next tick retries; the result carries the output anyway.
      } finally {
        reader.reading = false
      }
    }
    reader.timer = setInterval(() => detach(read(), 'opencode shell output'), SHELL_POLL_MS)
    reader.timer.unref()
    detach(read(), 'opencode shell output')
  }

  private stopShellReader(callId: string): void {
    const reader = this.shellReaders.get(callId)
    if (!reader) return
    if (reader.timer) clearInterval(reader.timer)
    this.shellReaders.delete(callId)
  }

  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'opencode') return false
    if (JSON.stringify(this.launchConfig(config).launch) !== JSON.stringify(this.launched)) return false
    this.config = config
    return true
  }

  /** Reloading cancels pending permissions and forms (2.x documentation): wait for idle. */
  async reloadSkillLibrary(): Promise<void> {
    if (this.turn.open) {
      this.reloadPending = true
      return
    }
    await this.reloadInstance()
  }

  async reconnectMcpServer(name: string): Promise<boolean> {
    const server = this.server
    if (!server) return false
    await server.post(`/api/experimental/mcp/${encodeURIComponent(name)}/connect`)
    this.lastMcpPayload = null
    await this.publishMcpStatus()
    return true
  }

  private reloadInstance(): Promise<void> {
    this.reloadPending = false
    const server = this.server
    if (!server) return Promise.resolve()
    this.reloading ??= server
      .post('/api/location/reload')
      .then(() => {
        detach(this.publishMcpStatus(), 'MCP status publication')
        return this.publishCommands()
      })
      .catch((err: unknown) => {
        process.stderr.write(`[opencode ${this.conversationId}] relecture des skills impossible : ${err instanceof Error ? err.message : String(err)}\n`)
      })
      .finally(() => { this.reloading = null })
    return this.reloading
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.interactions.resolvePermission(requestId, decision)
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    return this.interactions.resolveQuestion(requestId, answer)
  }

  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    return this.interactions.resolveElicitation(requestId, answer)
  }

  reviewPlan(_requestId: string, _review: PlanReview): boolean {
    return false
  }

  async suggestedTitle(): Promise<string | null> {
    return this.suggested
  }

  async interrupt(): Promise<void> {
    if (!this.server || !this.sessionId || !this.turn.open) {
      this.turn.settleWithoutTurn()
      return
    }
    const { interrupted } = await this.server.post<{ interrupted: boolean }>(`/api/session/${this.sessionId}/interrupt`)
    // Nothing was running: the turn we believed open is stale.
    if (!interrupted) {
      this.turnAborted = true
      this.endTurn()
      return
    }
    this.turn.armWatchdog(INTERRUPT_GRACE_MS, () => {
      this.turnAborted = true
      this.endTurn()
    })
  }

  async stop(): Promise<void> {
    this.turn.dispose()
    for (const callId of [...this.shellReaders.keys()]) this.stopShellReader(callId)
    const server = this.server
    this.server = null
    this.interactions.expireAll()
    server?.close()
  }
}

/** Sillage message ID of a streamed block: one per assistant message, kind and ordinal. */
function textKey(messageId: string, type: string, ordinal: number): string {
  return `${messageId}:${type.startsWith('session.reasoning') ? 'reasoning' : 'text'}:${ordinal}`
}

/** Job kinds under Claude's names, which the UI already translates. */
function jobKind(job: JobInfo): string {
  if (job.kind === 'subagent') return 'local_agent'
  if (job.kind === 'shell') return 'local_bash'
  return job.kind
}

function jobDescription(job: JobInfo): string {
  if (job.kind === 'subagent') return job.description || job.title || job.agent
  if (job.kind === 'shell') return job.title || job.command
  return job.title ?? job.kind
}
