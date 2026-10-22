import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  parseSlashCommand,
  usableSlashCommands,
  type AgentConfig,
  type AgentQuestion,
  type McpServer,
  type McpServerStatus,
  type OpencodeConfig,
} from '@sillage/protocol'
import type {
  Command,
  Config,
  Event,
  EventOf,
  MCPStatus,
  Message,
  PartOf,
  RequestBody,
  ResponseBody,
  Session,
  ToolPart,
} from '@sillage/opencode-bindings'
import type {
  AgentRunner,
  ElicitationAnswer,
  OutgoingAttachment,
  OutgoingMention,
  PermissionDecision,
  PlanReview,
  QuestionAnswer,
  RunnerContext,
} from '../types.js'
import { PendingInteractions } from '../interactions.js'
import { failedStatuses } from '../mcp-registry.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { agentProcessEnv } from '../process-env.js'
import { journalDeath } from '../session-close.js'
import { fromOpencodeMcpStatus, sameLaunchConfig, toOpencodeConfig } from './config.js'
import { describeSessionError, isAbort, type SessionError } from './errors.js'
import { parseModel } from './model.js'
import { OpencodeServer } from './server.js'
import { describePermission, describeTool, fileEdits, QUESTION_TOOL } from './tools.js'

/**
 * opencode adapter (I3): translate opencode serve stream to common event schema.
 *
 * One server per conversation like Codex app-server: permissions/MCP/skills read at launch
 * (config.ts); model/variant/primary agent sent per message, change live.
 *
 * Behavior probed on 1.18.25 and rechecked 1.19.0/1.19.3 (last 1.x before OpenCode 2).
 */

/** Time for opencode to close interrupted turns before forcing idle. */
const INTERRUPT_GRACE_MS = 15_000

/** Temporary pre-generated opencode title, not a real title. */
const PLACEHOLDER_TITLE = /^(New session|Child session) - \d{4}-/

/** Events unrelated to conversation or from second API generation. */
const NOISE = [
  'server.', 'plugin.', 'catalog.', 'reference.', 'integration.', 'installation.',
  'file.', 'lsp.', 'vcs.', 'pty.', 'tui.', 'project.', 'workspace.', 'worktree.',
  'global.', 'command.', 'session.next.', 'session.diff', 'session.deleted',
  'message.removed', 'message.part.removed', 'mcp.browser.', 'models-dev.',
]

type PromptBody = NonNullable<RequestBody<'session.prompt_async'>>
type PromptPart = PromptBody['parts'][number]

/** Text/reasoning part currently being written. */
interface OpenPart {
  kind: 'text' | 'thinking'
  text: string
  messageId: string
  parent: string | null
}

/** Already reported tool state, to journal changes only. */
interface ToolTrack {
  input: string
  output: string
}

function boundedAdd(set: Set<string>, value: string, max = 4096): void {
  set.add(value)
  if (set.size > max) set.delete(set.values().next().value!)
}

export class OpencodeRunner implements AgentRunner {
  readonly conversationId: string

  private server: OpencodeServer | null = null
  private sessionId: string | null = null
  private config: OpencodeConfig
  /** Configuration used to launch server. */
  private launched: Config = {}
  private mcpServers: McpServer[] = []
  private mcpFailures: McpServerStatus[] = []
  private lastMcpPayload: string | null = null
  private readonly interactions: PendingInteractions
  /** Native request (per_…, que_…) mapped to Sillage request ID. */
  private readonly nativeRequests = new Map<string, string>()
  /** Requests opencode closed itself, requiring no answer. */
  private readonly settledNatively = new Set<string>()

  /** Role per seen message; parts omit it. */
  private readonly messages = new Map<string, { role: Message['role']; summary: boolean }>()
  private readonly openParts = new Map<string, OpenPart>()
  private readonly closedParts = new Set<string>()
  private readonly tools = new Map<string, ToolTrack>()
  private readonly closedTools = new Set<string>()
  /** Assistant message provider/model, not repeated by parts. */
  private readonly assistantModels = new Map<string, string>()
  /** Subagent session mapped to launching task call. */
  private readonly children = new Map<string, string | null>()
  private readonly noticed = new Set<string>()

  private turnActive = false
  private turn = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  private turnAborted = false
  private turnFailed = false
  /** Compaction announced but not closed. */
  private compacting = false
  private lastAssistantMessageId: string | null = null
  private interruptWatchdog: NodeJS.Timeout | null = null

  /** Context windows per provider/model, read at launch. */
  private readonly contextLimits = new Map<string, number>()
  private defaultModel: string | null = null
  private commandNames = new Set<string>()
  /** Instance reload in progress: messages wait. */
  private reloading: Promise<void> | null = null
  /** Library changed mid-turn: reread at end. */
  private reloadPending = false
  private suggested: string | null = null

  /** See AgentRunner. this.config advances only after successful application. */
  get appliedConfig(): AgentConfig {
    return this.config
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as OpencodeConfig
    this.interactions = new PendingInteractions(ctx)
  }

  private launchConfig(config: OpencodeConfig): { launch: Config; servers: McpServer[]; failures: McpServerStatus[] } {
    const resolved = this.ctx.resolveMcpServers(config)
    const memoryDir = this.ctx.memoryDir()
    return {
      launch: toOpencodeConfig({
        config,
        mcpServers: resolved.servers,
        skillRoots: this.ctx.skillRoots(config),
        // Attachments/project memory outside cwd need explicit read rules to avoid permission
        // prompts.
        readableDirs: [this.ctx.attachmentsRoot, ...(memoryDir ? [memoryDir] : [])],
      }),
      servers: resolved.servers,
      failures: failedStatuses(resolved.failures),
    }
  }

  async start(): Promise<void> {
    const { launch, servers, failures } = this.launchConfig(this.config)
    this.launched = launch
    this.mcpServers = servers
    this.mcpFailures = failures

    // Project uses SILLAGE.md through system: reading repository AGENTS.md duplicates instructions.
    // No finer opencode switch: also disables project opencode.json/.opencode. Machine
    // ~/.config/opencode/AGENTS.md remains read.
    const masked = this.ctx.maskedInstructionRoots().length > 0
    this.server = await OpencodeServer.start({
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
      onReconnect: () => void this.resync(),
      onExit: (code) => this.onProcessExit(code),
    })

    // Sessions live in opencode database, not process: resume only checks existence.
    const session = this.ctx.resumeSessionId
      ? await this.server.get<Session>(`/session/${this.ctx.resumeSessionId}`)
      : await this.server.post<Session>('/session', {})

    await this.loadCatalog()

    this.sessionId = session.id
    this.ctx.setAgentSessionId(session.id)
    this.ctx.emit(
      {
        type: 'session.started',
        agent: 'opencode',
        agentSessionId: session.id,
        model: this.config.model || this.defaultModel || '',
        cwd: session.directory,
        // Tool list depends on turn agent/model: empty beats guessed.
        tools: [],
      },
      session,
    )
    void this.publishMcpStatus()
    void this.publishCommands()
  }

  /**
   * Default model/context windows, absent from stream. Without window gauge lacks denominator.
   * Probe failure leaves session running without gauge.
   */
  private async loadCatalog(): Promise<void> {
    try {
      const listing = await this.server!.get<ResponseBody<'config.providers'>>('/config/providers')
      for (const provider of listing.providers) {
        for (const model of Object.values(provider.models)) {
          this.contextLimits.set(`${provider.id}/${model.id}`, model.limit.context)
        }
      }
      const configured = (await this.server!.get<Config>('/config')).model
      const first = listing.providers[0]
      const fallback = first ? listing.default[first.id] : undefined
      this.defaultModel = configured ?? (first && fallback ? `${first.id}/${fallback}` : null)
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] catalogue indisponible : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  /**
   * Publish MCP inventory, skipping duplicates: opencode signals every tool change and each
   * triggers full inventory read.
   */
  private async publishMcpStatus(): Promise<void> {
    const server = this.server
    if (!server) return
    try {
      const statuses = await server.get<Record<string, MCPStatus>>('/mcp')
      const servers = [...this.mcpFailures, ...fromOpencodeMcpStatus(statuses, this.mcpServers)]
      const payload = JSON.stringify(servers)
      if (payload === this.lastMcpPayload) return
      this.lastMcpPayload = payload
      this.ctx.emit({ type: 'mcp.updated', servers })
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] inventaire MCP indisponible : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  /**
   * Publish slash commands, including skills (source: skill) and Sillage library. Unlike Codex, no
   * separate skill inventory.
   */
  private async publishCommands(): Promise<void> {
    const server = this.server
    if (!server) return
    try {
      const commands = usableSlashCommands(toSlashCommands(await server.get<Command[]>('/command')))
      this.commandNames = new Set(commands.map((command) => command.name))
      this.ctx.emit({ type: 'commands.updated', commands })
    } catch (err) {
      process.stderr.write(`[opencode ${this.conversationId}] commandes indisponibles : ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  /**
   * Unexpected process death: close prompts, journal failure, set error so manager frees session.
   * Next message resumes.
   */
  private onProcessExit(code: number | null): void {
    this.server = null
    this.turnActive = false
    this.clearInterruptWatchdog()

    // Death during startup: session never existed, start fails and manager reports. Journaling here
    // would end a conversation that never started.
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

  /** After stream disconnect, turn may have ended unheard. */
  private async resync(): Promise<void> {
    if (!this.server || !this.sessionId) return
    try {
      const statuses = await this.server.get<ResponseBody<'session.status'>>('/session/status')
      // Idle sessions are absent from table, not marked idle.
      const status = statuses[this.sessionId]
      if (this.turnActive && (!status || status.type === 'idle')) this.endTurn()
    } catch {
      // Reconnected stream reports subsequent events.
    }
  }

  private inTree(sessionId: string | undefined): sessionId is string {
    return sessionId !== undefined && (sessionId === this.sessionId || this.children.has(sessionId))
  }

  /** Ancestor task call for session, null for main. */
  private parentOf(sessionId: string): string | null {
    return sessionId === this.sessionId ? null : (this.children.get(sessionId) ?? null)
  }

  private translate(event: Event): void {
    switch (event.type) {
      case 'session.created': {
        const { info } = event.properties
        // Launching task links it once metadata arrives.
        if (info.parentID && this.inTree(info.parentID) && !this.children.has(info.id)) {
          this.children.set(info.id, null)
        }
        return
      }

      case 'session.updated': {
        const { info } = event.properties
        if (info.id === this.sessionId && info.title && !PLACEHOLDER_TITLE.test(info.title)) {
          this.suggested = info.title
        }
        return
      }

      case 'session.status': {
        const { sessionID, status } = event.properties
        if (sessionID !== this.sessionId) return
        if (status.type === 'busy') this.beginTurn()
        else if (status.type === 'retry') {
          this.beginTurn()
          this.notice('retry', `opencode réessaie (tentative ${status.attempt}) : ${status.message}`, 'info', status, `opencode-retry:${this.sessionId}`)
        } else this.endTurn()
        return
      }

      case 'session.idle':
        if (event.properties.sessionID === this.sessionId) this.endTurn()
        return

      case 'session.error': {
        const { sessionID, error } = event.properties
        // Without ID, instance-wide failure concerns us.
        if (sessionID === undefined || sessionID === this.sessionId) this.reportError(error, event)
        return
      }

      case 'session.compacted':
        if (event.properties.sessionID !== this.sessionId) return
        this.compacting = false
        this.ctx.emit({ type: 'context.compacted', trigger: 'unknown', preTokens: null, postTokens: null }, event)
        return

      case 'message.updated':
        this.onMessage(event.properties.info, event)
        return

      case 'message.part.updated':
        this.onPart(event)
        return

      case 'message.part.delta': {
        const { partID, field, delta } = event.properties
        const open = this.openParts.get(partID)
        // Unknown parts recover text from next complete version.
        if (!open || field !== 'text') return
        open.text += delta
        this.ctx.emit({
          type: open.kind === 'text' ? 'message.delta' : 'thinking.delta',
          messageId: partID,
          text: delta,
          parentToolCallId: open.parent,
        })
        return
      }

      case 'permission.asked':
        this.onPermissionAsked(event)
        return

      case 'question.asked':
        this.onQuestionAsked(event)
        return

      // opencode closed request externally or on interruption. Our own answers are already removed.
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected': {
        const requestId = this.nativeRequests.get(event.properties.requestID)
        if (!requestId) return
        this.settledNatively.add(event.properties.requestID)
        this.interactions.expire(requestId)
        if (this.turnActive) this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
        return
      }

      case 'todo.updated': {
        if (event.properties.sessionID !== this.sessionId) return
        this.ctx.emit({
          type: 'plan.updated',
          // Canceled tasks have no shared-schema state: remove from plan.
          items: event.properties.todos
            .filter((todo) => todo.status !== 'cancelled')
            .map((todo) => ({
              text: todo.content,
              status: todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending',
            })),
        })
        return
      }

      case 'mcp.tools.changed':
        void this.publishMcpStatus()
        return

      default: {
        // Stream type broader than generated union (server.heartbeat).
        const type: string = event.type
        if (NOISE.some((prefix) => type.startsWith(prefix))) return
        // New-version events remain visible once.
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
    if (this.turnActive) return
    this.turnActive = true
    this.turnAborted = false
    this.turnFailed = false
    this.turn = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
  }

  /**
   * Turn complete: session.idle authoritative, emitted twice.
   *
   * Probed: interruption idle precedes active-tool error closure, and permission requests remain
   * without permission.replied. Close everything here without waiting further.
   */
  private endTurn(): void {
    if (!this.turnActive) return
    this.turnActive = false
    this.clearInterruptWatchdog()

    for (const id of [...this.openParts.keys()]) this.closePart(id)
    for (const id of [...this.tools.keys()]) {
      this.tools.delete(id)
      boundedAdd(this.closedTools, id)
      this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: 'Tool execution aborted', isError: true, durationMs: 0 })
    }
    for (const native of this.nativeRequests.keys()) this.settledNatively.add(native)
    this.interactions.expireAll()
    this.compacting = false

    this.ctx.emit(
      {
        type: 'turn.completed',
        stopReason: this.turnAborted ? 'interrupted' : this.turnFailed ? 'failed' : 'completed',
        costUsd: this.turn.cost,
        inputTokens: this.turn.input,
        outputTokens: this.turn.output,
        cacheReadTokens: this.turn.cacheRead,
        cacheCreationTokens: this.turn.cacheWrite,
      },
      // Last turn message provides fork cut.
      { sessionID: this.sessionId, messageID: this.lastAssistantMessageId },
    )
    this.ctx.setStatus('idle')
    if (this.reloadPending) void this.reloadInstance()
  }

  private reportError(error: SessionError | undefined, raw: unknown): void {
    if (!error) return
    if (isAbort(error)) {
      this.turnAborted = true
      return
    }
    // Same failure arrives through session.error and closed assistant message.
    if (this.turnFailed) return
    this.turnFailed = true
    this.ctx.emit(describeSessionError(error), raw)
  }

  private onMessage(info: Message, raw: unknown): void {
    if (!this.inTree(info.sessionID)) return
    const summary = info.role === 'assistant' && info.summary === true
    this.messages.set(info.id, { role: info.role, summary })
    if (info.role !== 'assistant') return

    this.assistantModels.set(info.id, `${info.providerID}/${info.modelID}`)
    if (this.assistantModels.size > 256) this.assistantModels.delete(this.assistantModels.keys().next().value!)

    if (info.sessionID === this.sessionId) {
      if (summary) {
        // Automatic compaction announced only by summary message.
        if (!this.compacting) {
          this.compacting = true
          this.ctx.emit({ type: 'context.compaction_started' })
        }
      } else {
        this.lastAssistantMessageId = info.id
      }
      if (info.error) this.reportError(info.error, raw)
    }

    // Closed messages receive nothing more: close open parts too.
    if (info.time.completed) {
      for (const [id, open] of this.openParts) {
        if (open.messageId === info.id) this.closePart(id, raw)
      }
    }
  }

  private onPart(event: EventOf<'message.part.updated'>): void {
    const { part } = event.properties
    if (!this.inTree(part.sessionID)) return
    const message = this.messages.get(part.messageID)
    // User parts echo Sillage-journaled sends; compaction-summary parts stay hidden.
    if (message?.role !== 'assistant' || message.summary) return
    const parent = this.parentOf(part.sessionID)

    switch (part.type) {
      case 'text':
        if (part.synthetic || part.ignored) return
        this.onTextPart(part.id, 'text', part.text, part.messageID, part.time?.end !== undefined, parent, event.properties)
        return
      case 'reasoning':
        this.onTextPart(part.id, 'thinking', part.text, part.messageID, part.time.end !== undefined, parent, event.properties)
        return
      case 'tool':
        this.onToolPart(part, parent, event.properties)
        return
      case 'step-finish':
        this.onStepFinish(part, this.modelOf(part.messageID, event))
        return
      default:
        // step-start, patch, snapshot… internal opencode mechanics, nothing to show.
        return
    }
  }

  /**
   * Text/reasoning deltas bracketed by complete part versions. Complete version authoritative:
   * missing accumulated suffix becomes catch-up delta.
   */
  private onTextPart(
    id: string, kind: OpenPart['kind'], text: string, messageId: string, ended: boolean,
    parent: string | null, raw: unknown,
  ): void {
    if (this.closedParts.has(id)) return
    let open = this.openParts.get(id)
    if (!open) {
      open = { kind, text: '', messageId, parent }
      this.openParts.set(id, open)
    }
    if (text.length > open.text.length && text.startsWith(open.text)) {
      this.ctx.emit({
        type: kind === 'text' ? 'message.delta' : 'thinking.delta',
        messageId: id,
        text: text.slice(open.text.length),
        parentToolCallId: parent,
      })
    }
    if (text.length >= open.text.length) open.text = text
    if (ended) this.closePart(id, raw)
  }

  private closePart(id: string, raw?: unknown): void {
    const open = this.openParts.get(id)
    if (!open) return
    this.openParts.delete(id)
    boundedAdd(this.closedParts, id)
    // Provider-hidden reasoning arrives empty: nothing to show.
    if (!open.text.trim()) return
    this.ctx.emit(
      {
        type: 'message.completed',
        messageId: id,
        role: 'assistant',
        blocks: [{ type: open.kind, text: open.text }],
        parentToolCallId: open.parent,
      },
      raw,
    )
  }

  private onToolPart(part: ToolPart, parent: string | null, raw: unknown): void {
    if (part.tool === QUESTION_TOOL || this.closedTools.has(part.callID)) return
    const { state } = part
    const described = describeTool(part.tool, state.input, this.mcpServers.map((server) => server.name))
    const input = JSON.stringify(described.input)

    let track = this.tools.get(part.callID)
    if (!track) {
      track = { input, output: '' }
      this.tools.set(part.callID, track)
      this.ctx.emit({ type: 'tool.started', toolCallId: part.callID, ...described, parentToolCallId: parent }, raw)
    } else if (input !== track.input) {
      // Input empty during model writing, complete at execution.
      track.input = input
      this.ctx.emit({ type: 'tool.input_updated', toolCallId: part.callID, input: described.input }, raw)
    }

    const metadata = 'metadata' in state ? (state.metadata ?? {}) : {}

    // Subagent session named only in call metadata.
    if (part.tool === 'task' && typeof metadata.sessionId === 'string') {
      this.children.set(metadata.sessionId, part.callID)
    }

    if (state.status === 'running') {
      // Command output accumulates in metadata.output.
      const output = typeof metadata.output === 'string' ? metadata.output : ''
      if (output.length > track.output.length && output.startsWith(track.output)) {
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: part.callID, chunk: output.slice(track.output.length) })
        track.output = output
      }
      return
    }

    if (state.status !== 'completed' && state.status !== 'error') return
    this.tools.delete(part.callID)
    boundedAdd(this.closedTools, part.callID)
    this.ctx.emit(
      {
        type: 'tool.completed',
        toolCallId: part.callID,
        output: state.status === 'completed' ? state.output : state.error,
        isError: state.status === 'error',
        durationMs: Math.max(0, state.time.end - state.time.start),
      },
      raw,
    )
    for (const edit of fileEdits(part, this.ctx.cwd)) this.ctx.emit(edit)
  }

  /** Part message provider/model for context-window lookup. */
  private modelOf(messageId: string, event: EventOf<'message.part.updated'>): string | null {
    // Only main session occupies gauged context.
    if (event.properties.part.sessionID !== this.sessionId) return null
    return this.assistantModels.get(messageId) ?? null
  }

  /** Model step ends with usage. input excludes cache: context occupancy sums all three. */
  private onStepFinish(part: PartOf<'step-finish'>, model: string | null): void {
    const { tokens } = part
    this.turn.cost += part.cost
    this.turn.input += tokens.input
    this.turn.output += tokens.output + tokens.reasoning
    this.turn.cacheRead += tokens.cache.read
    this.turn.cacheWrite += tokens.cache.write

    const used = tokens.input + tokens.cache.read + tokens.cache.write
    const limit = model ? this.contextLimits.get(model) : undefined
    this.ctx.emit({
      type: 'usage.updated',
      costUsd: part.cost,
      inputTokens: tokens.input,
      outputTokens: tokens.output + tokens.reasoning,
      context: limit && used > 0 ? { usedTokens: used, maxTokens: limit, ratio: used / limit } : null,
      rateLimit: null,
    })
  }

  private onPermissionAsked(event: EventOf<'permission.asked'>): void {
    const request = event.properties
    if (!this.inTree(request.sessionID) || this.nativeRequests.has(request.id)) return

    const details = describePermission(request.permission, request.patterns, request.metadata, this.ctx.cwd)
    const requestId = this.interactions.requestPermission(details, (decision) => {
      this.nativeRequests.delete(request.id)
      if (this.settledNatively.delete(request.id)) return
      // opencode has two scopes: once or instance lifetime. Expiration means rejection; no
      // unanswered variant.
      const reply = decision?.decision === 'allowed'
        ? (decision.scope === 'once' ? 'once' : 'always')
        : 'reject'
      this.reply(`/permission/${request.id}/reply`, { reply } satisfies RequestBody<'permission.reply'>)
    })
    this.nativeRequests.set(request.id, requestId)
  }

  private onQuestionAsked(event: EventOf<'question.asked'>): void {
    const request = event.properties
    if (!this.inTree(request.sessionID) || this.nativeRequests.has(request.id)) return

    // Answers follow question order, keyed by index.
    const questions: AgentQuestion[] = request.questions.map((question, index) => ({
      id: String(index),
      header: question.header,
      question: question.question,
      multiSelect: question.multiple === true,
      // Unless stated otherwise, opencode allows free text.
      allowOther: question.custom !== false,
      secret: false,
      options: question.options.map((option) => ({ ...option, preview: null })),
    }))

    const requestId = this.interactions.requestQuestion(questions, (answer) => {
      this.nativeRequests.delete(request.id)
      if (this.settledNatively.delete(request.id)) return
      if (answer?.status === 'answered') {
        this.reply(`/question/${request.id}/reply`, {
          answers: questions.map((question) => answer.answers[question.id] ?? []),
        } satisfies RequestBody<'question.reply'>)
      } else {
        this.reply(`/question/${request.id}/reject`, {})
      }
    })
    this.nativeRequests.set(request.id, requestId)
  }

  /** Answer requests: report failures without killing session. */
  private reply(path: string, body: unknown): void {
    const server = this.server
    if (!server) return
    server.post(path, body).catch((err: unknown) => {
      process.stderr.write(`[opencode ${this.conversationId}] réponse refusée sur ${path} : ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.interactions.resolvePermission(requestId, decision)
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    return this.interactions.resolveQuestion(requestId, answer)
  }

  /** opencode does not forward MCP elicitations: nothing pending. */
  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    return this.interactions.resolveElicitation(requestId, answer)
  }

  /** No plan-approval request: plan mode is selected agent, not blocking prompt. */
  reviewPlan(_requestId: string, _review: PlanReview): boolean {
    return false
  }

  /**
   * opencode message body.
   *
   * Images/mentioned files use file parts with file:// URLs read by opencode like TUI @ mentions.
   * Other attachments remain paths in text.
   */
  private promptBody(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): PromptBody {
    const parts: PromptPart[] = []
    if (text) parts.push({ type: 'text', text })
    for (const mention of mentions) {
      parts.push({
        type: 'file',
        mime: isDirectory(mention.path) ? 'application/x-directory' : 'text/plain',
        filename: mention.relativePath,
        url: pathToFileURL(mention.path).href,
      })
    }
    for (const attachment of attachments) {
      if (!attachment.inlineImage) continue
      parts.push({
        type: 'file',
        mime: attachment.mimeType,
        filename: attachment.filename,
        url: pathToFileURL(attachment.path).href,
      })
    }

    const model = parseModel(this.config.model)
    // Equivalent system-prompt appendix. system applies only to containing message, so resend every
    // time.
    const system = this.ctx.projectOverview(this.config)
    return {
      parts,
      agent: this.config.primaryAgent,
      // Without model/variant, opencode uses its own.
      ...(model ? { model } : {}),
      ...(this.config.variant ? { variant: this.config.variant } : {}),
      ...(system ? { system } : {}),
    }
  }

  async send(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): Promise<void> {
    if (!this.server || !this.sessionId) throw new Error("La session opencode n'est pas démarrée.")

    const { blocks, promptText } = describeOutgoingMessage(text, attachments)
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    this.ctx.setStatus('running')
    // Messages during reload would lose events.
    if (this.reloading) await this.reloading
    if (!this.server) throw new Error('La session opencode est fermée.')

    // prompt_async does not expand slash commands: dedicated route.
    const command = parseSlashCommand(text)
    if (command && this.commandNames.has(command.name)) {
      this.runCommand(command.name, command.args)
      return
    }

    try {
      await this.server.post(`/session/${this.sessionId}/prompt_async`, this.promptBody(promptText, attachments, mentions))
    } catch (error) {
      if (!this.turnActive && this.server) this.ctx.setStatus('idle')
      throw error
    }
  }

  /**
   * POST /command responds only at turn end, no async variant: fire without awaiting, failures
   * journaled.
   */
  private runCommand(name: string, args: string): void {
    const body: RequestBody<'session.command'> = {
      command: name,
      arguments: args,
      agent: this.config.primaryAgent,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.variant ? { variant: this.config.variant } : {}),
    }
    this.server!.post(`/session/${this.sessionId}/command`, body, null).catch((err: unknown) => {
      if (!this.server) return
      this.ctx.emit({
        type: 'error',
        code: 'turn_failed',
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      })
      if (!this.turnActive) this.ctx.setStatus('idle')
    })
  }

  /**
   * Steer active turn.
   *
   * Probed: mid-turn prompt_async neither opens another turn nor interrupts. Taken at next model
   * step inside same busy → idle interval.
   */
  async steer(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): Promise<boolean> {
    if (!this.server || !this.sessionId || !this.turnActive) return false

    const { blocks, promptText } = describeOutgoingMessage(text, attachments)
    await this.server.post(`/session/${this.sessionId}/prompt_async`, this.promptBody(promptText, attachments, mentions))
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    return true
  }

  /** Dedicated compaction request requires model: conversation’s, otherwise opencode default. */
  async compact(): Promise<boolean> {
    const model = parseModel(this.config.model || this.defaultModel || '')
    if (!this.server || !this.sessionId || !model) return false

    this.compacting = true
    this.ctx.emit({ type: 'context.compaction_started' })
    // Like /command, responds only after summary written.
    this.server
      .post(`/session/${this.sessionId}/summarize`, model satisfies RequestBody<'session.summarize'>, null)
      .catch((err: unknown) => {
        if (!this.server) return
        this.compacting = false
        this.notice('compaction_failed', `La compaction a échoué : ${err instanceof Error ? err.message : String(err)}`, 'warning')
        if (!this.turnActive) this.ctx.setStatus('idle')
      })
    return true
  }

  /** opencode reports no background work to stop. */
  async stopBackgroundTask(): Promise<boolean> {
    return false
  }

  /**
   * Model/variant/primary agent sent per message, no restart. Launch-config changes require new
   * server.
   */
  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'opencode') return false
    if (!sameLaunchConfig(this.launchConfig(config).launch, this.launched)) return false
    this.config = config
    return true
  }

  /**
   * Probed: running server misses added/renamed/deleted skills. Dispose instance to reread, which
   * would kill active turns, so wait for idle.
   */
  async reloadSkillLibrary(): Promise<void> {
    if (this.turnActive) {
      this.reloadPending = true
      return
    }
    await this.reloadInstance()
  }

  private reloadInstance(): Promise<void> {
    this.reloadPending = false
    const server = this.server
    if (!server) return Promise.resolve()
    this.reloading ??= server
      .reloadInstance()
      .then(() => {
        void this.publishMcpStatus()
        return this.publishCommands()
      })
      .catch((err: unknown) => {
        process.stderr.write(`[opencode ${this.conversationId}] relecture des skills impossible : ${err instanceof Error ? err.message : String(err)}\n`)
      })
      .finally(() => { this.reloading = null })
    return this.reloading
  }

  async suggestedTitle(): Promise<string | null> {
    return this.suggested
  }

  async interrupt(): Promise<void> {
    // No active turn means nothing to interrupt, but action remains escape hatch: falsely busy
    // conversations must become idle.
    if (!this.server || !this.sessionId || !this.turnActive) {
      this.interactions.expireAll()
      this.ctx.setStatus('idle')
      return
    }
    await this.server.post(`/session/${this.sessionId}/abort`)

    // session.idle authoritative closure; fallback covers missing event.
    this.clearInterruptWatchdog()
    this.interruptWatchdog = setTimeout(() => {
      this.turnAborted = true
      this.endTurn()
    }, INTERRUPT_GRACE_MS)
    this.interruptWatchdog.unref()
  }

  private clearInterruptWatchdog(): void {
    if (this.interruptWatchdog) clearTimeout(this.interruptWatchdog)
    this.interruptWatchdog = null
  }

  async stop(): Promise<void> {
    this.clearInterruptWatchdog()
    // Server leaves with its requests: no need deny individually.
    const server = this.server
    this.server = null
    this.interactions.expireAll()
    server?.close()
  }

}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Common-format opencode commands. hints lists expected $1, $ARGUMENTS… */
export function toSlashCommands(commands: Command[]) {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? '',
    argumentHint: command.hints.join(' '),
    aliases: [],
  }))
}
