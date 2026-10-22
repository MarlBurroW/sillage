import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type {
  ContentBlock as AcpContentBlock,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import {
  grokPermissionModeSchema,
  parseElicitationFields,
  parseSlashCommand,
  type AgentConfig,
  type AgentQuestion,
  type GrokConfig,
  type GrokPermissionMode,
  type McpServerStatus,
  type PlanFollowUpOption,
  type SillageEvent,
} from '@sillage/protocol'
import { AcpClient, AcpRpcError } from '../acp/client.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { PendingInteractions } from '../interactions.js'
import { failedStatuses } from '../mcp-registry.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { toWorkspacePath } from '../paths.js'
import { agentProcessEnv } from '../process-env.js'
import { journalDeath } from '../session-close.js'
import { ToolDurations } from '../tool-durations.js'
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
import { toSlashCommands } from './catalog.js'
import { grokLaunch, sameLaunch, toAcpMcpServer, type GrokLaunch } from './launch.js'
import {
  commandOutput,
  contentText,
  describeTool,
  diffsOf,
  fields,
  nativeToolName,
  QUESTION_TOOL,
  type AcpDiff,
} from './tools.js'

/** Grok Build adapter (invariant I3) normalizing `grok agent stdio` ACP. One process per conversation like Codex; turns are `session/prompt` requests responding only at completion with stop reasons and usage. Model, effort and permission mode change live; web tools, skills and MCP servers are launch-time settings. Grok extends ACP with `_x.ai/…` notifications and requests (`_x.ai/ask_user_question`, `_x.ai/exit_plan_mode`, `_x.ai/mcp/elicit`). Read only extensions adding otherwise unavailable state; ignore interface noise such as tips and TUI queues. All claims probed on Grok Build 1.0.62 and checked in public xai-org/grok-build Apache-2.0 sources. */

/** `_x.ai/…` notifications unrelated to journal content. */
const NOISE = new Set([
  '_x.ai/session/setup', '_x.ai/announcements/update', '_x.ai/settings/update', '_x.ai/models/update',
  '_x.ai/sessions/changed', '_x.ai/queue/changed', '_x.ai/session/prompt_complete', '_x.ai/mcp/init_progress',
  '_x.ai/mcp_initialized', '_x.ai/mcp/servers_updated', '_x.ai/mcp/tools_changed', '_x.ai/git_head_changed',
  '_x.ai/fs_notify', '_x.ai/fs/index', '_x.ai/fs/index/delta', '_x.ai/session/interjection', '_x.ai/hooks/event',
])

/** `_x.ai/session_notification` variants handled elsewhere or irrelevant to conversations. */
const NOTIFICATION_NOISE = new Set([
  'tool_call_delta_chunk', 'pending_interaction', 'interaction_resolved', 'response_completed', 'response_started',
  'turn_usage', 'model_changed', 'session_summary_generated', 'last_turn_summary', 'turn_completed',
  'image_compressed', 'auto_continue_completed',
])

/** `costUsdTicks` are ten-billionths of dollars (probed: $0.033 for 330,643,200). */
const USD_PER_TICK = 1e-10

/** Grace period for Grok to close canceled turns before forced completion. */
const CANCEL_GRACE_MS = 15_000

/** Plan-approval follow-up choices. Grok returns to `default` itself; 'let agent decide' subsequently switches to `auto`. */
const PLAN_FOLLOW_UP_OPTIONS: PlanFollowUpOption[] = [
  { id: 'default', label: 'Valider et demander', hint: 'Chaque écriture et chaque commande restent soumises à ton accord' },
  { id: 'auto', label: 'Valider et laisser décider', hint: "Grok n'interrompt que pour ce qui lui paraît risqué" },
]

/** Text or reasoning block currently streaming. */
interface OpenText {
  kind: 'text' | 'thinking'
  id: string
  text: string
}

/** Already-journaled tool state, preventing unchanged updates. */
interface ToolTrack {
  native: string
  input: string
  output: string
  diffs: AcpDiff[]
}

interface PromptUsage {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cacheCreationTokens?: number
  costUsdTicks?: number
}

/** Grok permission flags and session mode requested by Sillage modes. */
function permissionFlags(mode: GrokPermissionMode): { yoloMode: boolean; autoMode: boolean; sessionMode: string } {
  return {
    yoloMode: mode === 'bypassPermissions',
    autoMode: mode === 'auto',
    sessionMode: mode === 'plan' ? 'plan' : 'default',
  }
}

export class GrokRunner implements AgentRunner {
  readonly conversationId: string

  private client: AcpClient | null = null
  private sessionId: string | null = null
  private config: GrokConfig
  private launched: GrokLaunch | null = null
  /** MCP servers used when opening sessions. */
  private launchedMcp = ''
  private readonly interactions: PendingInteractions
  private readonly durations = new ToolDurations()

  private open: OpenText | null = null
  private readonly tools = new Map<string, ToolTrack>()
  /** Cardless calls (`ask_user_question`) whose later updates must remain hidden. */
  private readonly silentTools = new Set<string>()
  private mcpNames: string[] = []
  private mcpFailures: McpServerStatus[] = []
  private readonly mcpStatus = new Map<string, McpServerStatus>()
  /** Grok MCP `elicitationId` to Sillage request mapping. */
  private readonly elicitations = new Map<string, string>()
  private commandNames = new Set<string>()
  /** Latest published snapshots. Grok repeats commands at every model step and context sizes on every update including text fragments; journal only changes. */
  private lastCommands = ''
  private lastContext = 0
  private readonly noticed = new Set<string>()

  private turnActive = false
  private cancelWatchdog: NodeJS.Timeout | null = null
  /** Sillage-requested compaction in progress. */
  private compacting: 'manual' | 'auto' | null = null
  /** Per-model context windows from session catalogs. */
  private readonly contextLimits = new Map<string, number>()
  private currentModel: string | null = null
  private currentEffort: string | null = null
  private sessionMode = 'default'
  private suggested: string | null = null
  /** Notifications arriving before session IDs are known. Grok publishes commands and MCP states before `session/new` responds (probed); replay after responses rather than lose them. */
  private early: [string, unknown][] | null = []

  get appliedConfig(): AgentConfig {
    return this.config
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as GrokConfig
    this.interactions = new PendingInteractions(ctx)
  }

  private launchFor(config: GrokConfig): GrokLaunch {
    return grokLaunch(config, this.ctx.skillRoots(config))
  }

  async start(): Promise<void> {
    const launch = this.launchFor(this.config)
    this.launched = launch
    const resolved = this.ctx.resolveMcpServers(this.config)
    this.mcpNames = resolved.servers.map((server) => server.name)
    this.mcpFailures = failedStatuses(resolved.failures)
    this.launchedMcp = JSON.stringify(resolved.servers)

    this.client = new AcpClient({
      label: 'grok',
      binary: this.ctx.binary,
      args: launch.args,
      cwd: this.ctx.cwd,
      env: agentProcessEnv({ ...this.ctx.processEnv, ...launch.env }),
      onNotification: (method, params) => {
        try { this.onNotification(method, params) }
        catch (error) {
          this.notice('translation_failed', `Impossible de lire la notification Grok ${method} : ${error instanceof Error ? error.message : String(error)}`, 'warning', params)
        }
      },
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (code, stderr) => this.onProcessExit(code, stderr),
    })

    const init = await this.client.initialize(CLIENT_INFO)
    this.readModels(fields(fields(init._meta).modelState))

    const flags = permissionFlags(this.config.permissionMode)
    // Disable repository instructions through agent profiles: `agentsMd: false` is
    // the sole switch; otherwise `AGENTS.md`/`CLAUDE.md` always load.
    // Profiles replace defaults without changing tools (probed).
    const masked = this.ctx.maskedInstructionRoots().length > 0
    const meta = {
      yoloMode: flags.yoloMode,
      autoMode: flags.autoMode,
      ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}),
      ...(masked ? { agentProfile: { name: 'sillage', description: 'Sillage session', agentsMd: false } } : {}),
    }
    const mcpServers = resolved.servers.map(toAcpMcpServer)

    let session: NewSessionResponse | ResumeSessionResponse
    let sessionId: string
    if (this.ctx.resumeSessionId) {
      // Use session/resume rather than session/load: the latter replays all history through
      // `session/update`, already journaled. It rejects `additionalDirectories`.
      session = await this.client.request<ResumeSessionResponse>('session/resume', {
        sessionId: this.ctx.resumeSessionId,
        cwd: this.ctx.cwd,
        mcpServers,
        _meta: meta,
      })
      sessionId = this.ctx.resumeSessionId
    } else {
      // Project instructions (SILLAGE.md, memory, handoff) go through `rules`, appended
      // to system prompts in `<human_rules>`. Read only on creation:
      // resumes retain saved system prompts.
      // ACP `systemPrompt` is ignored (probed).
      const rules = this.ctx.projectOverview(this.config)
      const created = await this.client.request<NewSessionResponse>('session/new', {
        cwd: this.ctx.cwd,
        mcpServers,
        _meta: {
          ...meta,
          ...(rules ? { rules } : {}),
          ...(this.config.model ? { modelId: this.config.model } : {}),
        },
      })
      session = created
      sessionId = created.sessionId
    }
    this.sessionId = sessionId
    this.ctx.setAgentSessionId(sessionId)
    const early = this.early ?? []
    this.early = null

    this.readModels(fields((session as { models?: unknown }).models))
    this.readOptions(session.configOptions ?? [])
    await this.applySessionOptions(this.config)
    await this.applyPermissionMode(this.config.permissionMode, true)

    this.ctx.emit(
      {
        type: 'session.started',
        agent: 'grok',
        agentSessionId: sessionId,
        model: this.currentModel ?? this.config.model,
        cwd: this.ctx.cwd,
        tools: [],
      },
      session,
    )
    this.publishMcp()
    for (const [method, params] of early) this.onNotification(method, params)
  }

  /** Context windows and current model in `_meta.modelState` or `models`. */
  private readModels(models: Record<string, unknown>): void {
    for (const entry of Array.isArray(models.availableModels) ? models.availableModels : []) {
      const model = fields(entry)
      const limit = fields(model._meta).totalContextTokens
      if (typeof model.modelId === 'string' && typeof limit === 'number') this.contextLimits.set(model.modelId, limit)
    }
    if (typeof models.currentModelId === 'string') this.currentModel = models.currentModelId
  }

  private readOptions(options: SessionConfigOption[]): void {
    for (const option of options) {
      const value = (option as { currentValue?: unknown }).currentValue
      if (typeof value !== 'string') continue
      if (option.id === 'model') this.currentModel = value
      if (option.id === 'reasoning_effort') this.currentEffort = value
    }
  }

  /** Apply configured model/effort when differing from announced session settings. `CLI_DEFAULT` preserves Grok values. */
  private async applySessionOptions(config: GrokConfig): Promise<void> {
    const wanted: [string, string, string | null][] = [
      ['model', config.model, this.currentModel],
      ['reasoning_effort', config.reasoningEffort, this.currentEffort],
    ]
    for (const [configId, value, current] of wanted) {
      if (!value || current === value) continue
      const result = await this.client!.request<{ configOptions?: SessionConfigOption[] }>(
        'session/set_config_option',
        { sessionId: this.sessionId, configId, value },
      )
      this.readOptions(result.configOptions ?? [])
    }
  }

  /** Live permission modes. Notify `_x.ai/yolo_mode_changed` for `yoloMode`/`autoMode`, affecting all process sessions, of which there is one. Plan mode uses `session/set_mode`. */
  private async applyPermissionMode(mode: GrokPermissionMode, initial = false): Promise<void> {
    const flags = permissionFlags(mode)
    if (!initial) this.client!.notify('_x.ai/yolo_mode_changed', { yolo_mode: flags.yoloMode, auto_mode: flags.autoMode })
    if (flags.sessionMode !== this.sessionMode) {
      await this.client!.request('session/set_mode', { sessionId: this.sessionId, modeId: flags.sessionMode })
      this.sessionMode = flags.sessionMode
    }
  }

  private publishMcp(): void {
    this.ctx.emit({ type: 'mcp.updated', servers: [...this.mcpFailures, ...this.mcpStatus.values()] })
  }

  private onProcessExit(code: number | null, stderr: string): void {
    this.client = null
    const wasStarted = this.sessionId !== null
    this.turnActive = false
    this.clearCancelWatchdog()
    // Death during startup makes `start()` fail; managers report it.
    if (!wasStarted) return

    this.interactions.expireAll()
    this.ctx.setStatus('error')
    const tail = stderr.trim().split('\n').slice(-3).join('\n')
    journalDeath(this.ctx, {
      type: 'error',
      code: 'runner_failed',
      message: `grok agent s'est arrêté de façon inattendue (code ${code ?? 'inconnu'})${tail ? ` : ${tail}` : '.'}`,
      recoverable: true,
    })
  }

  // ─── Incoming stream ────────────────────────────────────────────────────────────

  private onNotification(method: string, params: unknown): void {
    if (this.early) {
      this.early.push([method, params])
      return
    }
    if (method === 'session/update') {
      const notification = params as SessionNotification
      // Subagents publish under their own session ID; only
      // their `task` results return to the main conversation.
      if (notification.sessionId !== this.sessionId) return
      this.onUpdate(notification)
      return
    }
    if (method === '_x.ai/session_notification') {
      const update = fields(fields(params).update)
      if (fields(params).sessionId !== this.sessionId) return
      this.onExtensionUpdate(update)
      return
    }
    if (method === '_x.ai/mcp/server_status') {
      this.onMcpStatus(params)
      return
    }
    if (method === '_x.ai/mcp/elicit_complete') {
      const id = fields(params).elicitationId
      const requestId = typeof id === 'string' ? this.elicitations.get(id) : undefined
      if (requestId) this.interactions.expire(requestId)
      return
    }
    if (NOISE.has(method)) return
    this.noticeOnce(method, `Notification Grok : ${method}`, params)
  }

  private onUpdate(notification: SessionNotification): void {
    const { update } = notification
    // Context sizes accompany every update's `_meta`.
    const totalTokens = fields(notification._meta).totalTokens
    if (typeof totalTokens === 'number' && totalTokens > 0) this.reportContext(totalTokens)

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const block = update.content as AcpContentBlock
        if (block.type !== 'text') return
        this.appendText(update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking', block.text)
        return
      }
      case 'user_message_chunk':
        // Echo of input Sillage already journaled on send.
        return
      case 'tool_call':
        this.closeText()
        this.onToolCall(update.toolCallId, update._meta, update.title, update.rawInput, notification)
        this.onToolUpdate(update.toolCallId, update, notification)
        return
      case 'tool_call_update':
        this.closeText()
        if (!this.tools.has(update.toolCallId) && !this.silentTools.has(update.toolCallId)) {
          this.onToolCall(update.toolCallId, update._meta, update.title, update.rawInput, notification)
        }
        this.onToolUpdate(update.toolCallId, update, notification)
        return
      case 'plan':
        this.ctx.emit({
          type: 'plan.updated',
          items: update.entries.map((entry) => ({ text: entry.content, status: entry.status })),
        })
        return
      case 'available_commands_update': {
        const commands = toSlashCommands(update.availableCommands)
        const payload = JSON.stringify(commands)
        if (payload === this.lastCommands) return
        this.lastCommands = payload
        this.commandNames = new Set(commands.map((command) => command.name))
        this.ctx.emit({ type: 'commands.updated', commands })
        return
      }
      case 'session_info_update':
        if (update.title) this.suggested = update.title
        return
      case 'config_option_update':
        this.readOptions(update.configOptions)
        return
      case 'current_mode_update':
        this.onModeChanged(update.currentModeId)
        return
      case 'usage_update':
        if (update.size > 0) this.emitContext(update.used, update.size)
        return
      default:
        this.noticeOnce(`update:${update.sessionUpdate}`, `Mise à jour Grok : ${update.sessionUpdate}`, update)
    }
  }

  /** Grok-specific variants absent from standard ACP. */
  private onExtensionUpdate(update: Record<string, unknown>): void {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
    switch (kind) {
      case 'auto_compact_started':
        if (!this.compacting) {
          this.compacting = 'auto'
          this.ctx.emit({ type: 'context.compaction_started' })
        }
        return
      case 'auto_compact_completed': {
        const trigger = this.compacting ?? 'auto'
        this.compacting = null
        this.ctx.emit({
          type: 'context.compacted',
          trigger,
          preTokens: typeof update.tokens_before === 'number' ? update.tokens_before : null,
          postTokens: typeof update.tokens_after === 'number' ? update.tokens_after : null,
        }, update)
        return
      }
      case 'auto_compact_failed':
      case 'auto_compact_cancelled':
        this.compacting = null
        this.notice('compaction_failed', `La compaction n'a pas abouti (${kind}).`, 'warning', update)
        return
      default:
        if (NOTIFICATION_NOISE.has(kind)) return
        this.noticeOnce(`x:${kind}`, `Événement Grok : ${kind}`, update)
    }
  }

  /** Grok changes modes itself after plan approval. Update configuration so controls and resumed sessions do not revert to plan mode. */
  private onModeChanged(mode: string): void {
    this.sessionMode = mode
    if (mode !== 'plan' && this.config.permissionMode === 'plan') {
      this.config = { ...this.config, permissionMode: 'default' }
      this.ctx.updateConfig(this.config)
    }
  }

  private reportContext(used: number): void {
    const limit = this.currentModel ? this.contextLimits.get(this.currentModel) : undefined
    if (limit) this.emitContext(used, limit)
  }

  private emitContext(used: number, limit: number): void {
    if (used === this.lastContext) return
    this.lastContext = used
    this.ctx.emit({
      type: 'usage.updated',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      context: { usedTokens: used, maxTokens: limit, ratio: Math.min(1, used / limit) },
      rateLimit: null,
    })
  }

  /** Text/reasoning chunks have no message IDs (probed): retain blocks until another content kind interrupts. */
  private appendText(kind: OpenText['kind'], text: string): void {
    if (!text) return
    if (this.open && this.open.kind !== kind) this.closeText()
    if (!this.open) this.open = { kind, id: randomUUID(), text: '' }
    this.open.text += text
    this.ctx.emit({
      type: kind === 'text' ? 'message.delta' : 'thinking.delta',
      messageId: this.open.id,
      text,
      parentToolCallId: null,
    })
  }

  private closeText(): void {
    const open = this.open
    if (!open) return
    this.open = null
    if (!open.text.trim()) return
    this.ctx.emit({
      type: 'message.completed',
      messageId: open.id,
      role: 'assistant',
      blocks: [{ type: open.kind, text: open.text }],
      parentToolCallId: null,
    })
  }

  private onToolCall(id: string, meta: unknown, title: unknown, rawInput: unknown, raw: unknown): void {
    if (this.tools.has(id) || this.silentTools.has(id)) return
    const native = nativeToolName(meta, title)
    if (native === QUESTION_TOOL) {
      this.silentTools.add(id)
      return
    }
    const described = describeTool(native, rawInput)
    this.tools.set(id, { native, input: JSON.stringify(described.input), output: '', diffs: [] })
    this.durations.start(id)
    this.ctx.emit({ type: 'tool.started', toolCallId: id, ...described, parentToolCallId: null }, raw)
  }

  /** Tool updates refine input (Grok adds `variant`), accumulate command `rawOutput.output`, then complete calls. */
  private onToolUpdate(
    id: string,
    update: { status?: string | null; rawInput?: unknown; rawOutput?: unknown; content?: unknown },
    raw: unknown,
  ): void {
    const track = this.tools.get(id)
    if (!track) {
      if (update.status === 'completed' || update.status === 'failed') this.silentTools.delete(id)
      return
    }

    if (update.rawInput !== undefined) {
      const described = describeTool(track.native, update.rawInput)
      const input = JSON.stringify(described.input)
      if (input !== track.input) {
        track.input = input
        this.ctx.emit({ type: 'tool.input_updated', toolCallId: id, input: described.input }, raw)
      }
    }
    const diffs = diffsOf(update.content)
    if (diffs.length > 0) track.diffs = diffs

    const output = commandOutput(update.rawOutput)
    if (output !== null && output.length > track.output.length && output.startsWith(track.output)) {
      this.ctx.emit({ type: 'tool.output_delta', toolCallId: id, chunk: output.slice(track.output.length) })
      track.output = output
    }

    if (update.status !== 'completed' && update.status !== 'failed') return
    this.tools.delete(id)
    const failed = update.status === 'failed'
    this.ctx.emit(
      {
        type: 'tool.completed',
        toolCallId: id,
        output: toolOutput(update, track),
        isError: failed,
        durationMs: this.durations.stop(id),
      },
      // Retain pre-completion `diff` blocks for `describeEdit`.
      { update, diffs: track.diffs },
    )
    if (!failed) for (const event of this.fileEdits(id, track)) this.ctx.emit(event)
  }

  private fileEdits(id: string, track: ToolTrack): SillageEvent[] {
    return track.diffs.map((diff) => ({
      type: 'file.edited' as const,
      toolCallId: id,
      path: toWorkspacePath(this.ctx.cwd, diff.path),
      action: diff.oldText === null || diff.oldText === '' ? ('created' as const) : ('modified' as const),
    }))
  }

  private onMcpStatus(params: unknown): void {
    const status = fields(params)
    if (status.sessionId !== this.sessionId || typeof status.name !== 'string') return
    const state = status.status === 'ready' ? 'connected' : status.status === 'failed' || status.status === 'error' ? 'failed' : 'pending'
    const tools = Array.isArray(status.tools) ? status.tools.filter((tool): tool is string => typeof tool === 'string') : []
    this.mcpStatus.set(status.name, {
      name: status.name,
      state,
      tools,
      error: state === 'failed' && typeof status.reason === 'string' ? status.reason : null,
      external: !this.mcpNames.includes(status.name),
    })
    this.publishMcp()
  }

  // ─── Agent requests ─────────────────────────────────────────────────────────

  private onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'session/request_permission':
        return this.onPermission(params as RequestPermissionRequest)
      case '_x.ai/ask_user_question':
        return this.onQuestion(fields(params))
      case '_x.ai/exit_plan_mode':
        return this.onPlanReview(fields(params))
      case '_x.ai/mcp/elicit':
        return this.onElicitation(fields(params))
      default:
        return Promise.reject(new AcpRpcError(`Method not supported by Sillage: ${method}`, -32601))
    }
  }

  /** Permission requests. Grok proposes native options (`allow-once`, `allow-edits-session`, `always-allow`, `reject-once`…) and reads responses by kind; choose the user action's option while retaining its native ID. Rejections end whole turns (`PermissionRejected`), not just calls. */
  private onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const call = request.toolCall
    const described = describeTool(nativeToolName(call._meta, call.title), call.rawInput)
    return new Promise((resolve) => {
      this.interactions.requestPermission(
        { toolName: described.name, input: described.input, title: typeof call.title === 'string' ? call.title : null },
        (decision) => {
          if (!decision) {
            resolve({ outcome: { outcome: 'cancelled' } })
            return
          }
          const kinds = decision.decision === 'allowed'
            ? decision.scope === 'once' ? ['allow_once', 'allow_always'] : ['allow_always', 'allow_once']
            : ['reject_once', 'reject_always']
          const option = kinds.map((kind) => request.options.find((entry) => entry.kind === kind)).find(Boolean)
          resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } })
        },
      )
    })
  }

  /** `ask_user_question` requests keyed by question headings as Grok requires. */
  private onQuestion(params: Record<string, unknown>): Promise<unknown> {
    const listed = Array.isArray(params.questions) ? params.questions.map(fields) : []
    const questions: AgentQuestion[] = listed
      .filter((question) => typeof question.question === 'string')
      .map((question) => ({
        id: String(question.question),
        header: typeof question.header === 'string' ? question.header : '',
        question: String(question.question),
        multiSelect: question.multiSelect === true,
        allowOther: true,
        secret: false,
        options: (Array.isArray(question.options) ? question.options.map(fields) : []).map((option) => ({
          label: String(option.label ?? ''),
          description: typeof option.description === 'string' ? option.description : '',
          preview: typeof option.preview === 'string' ? option.preview : null,
        })),
      }))
    return new Promise((resolve) => {
      this.interactions.requestQuestion(questions, (answer) => {
        resolve(answer?.status === 'answered' ? { outcome: 'accepted', answers: answer.answers } : { outcome: 'cancelled' })
      })
    })
  }

  /** Plan submitted by Grok when leaving plan mode (exit_plan_mode). */
  private onPlanReview(params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      this.interactions.requestPlanReview(
        { plan: typeof params.planContent === 'string' ? params.planContent : '', followUpOptions: PLAN_FOLLOW_UP_OPTIONS },
        (review) => {
          if (review?.decision !== 'approved') {
            resolve({ outcome: 'cancelled' })
            return
          }
          resolve({ outcome: 'approved' })
          const parsed = grokPermissionModeSchema.safeParse(review.followUpMode)
          const mode = parsed.success && (parsed.data === 'auto' || parsed.data === 'default') ? parsed.data : 'default'
          // Grok returns to `default` itself; only `auto` needs another action.
          this.sessionMode = 'default'
          if (mode === 'auto') this.client?.notify('_x.ai/yolo_mode_changed', { yolo_mode: false, auto_mode: true })
          this.config = { ...this.config, permissionMode: mode }
          this.ctx.updateConfig(this.config)
        },
      )
    })
  }

  private onElicitation(params: Record<string, unknown>): Promise<unknown> {
    const mode = params.mode === 'url' ? 'url' : 'form'
    return new Promise((resolve) => {
      const requestId = this.interactions.requestElicitation(
        {
          serverName: typeof params.serverName === 'string' ? params.serverName : 'mcp',
          mode,
          message: typeof params.message === 'string' ? params.message : '',
          url: mode === 'url' && typeof params.url === 'string' ? params.url : null,
          fields: mode === 'form' ? parseElicitationFields(params.requestedSchema) : [],
          title: null,
        },
        (answer) => {
          if (typeof params.elicitationId === 'string') this.elicitations.delete(params.elicitationId)
          if (!answer) resolve({ outcome: 'cancel' })
          else if (answer.action === 'accept') resolve({ outcome: 'accept', content: answer.content })
          else resolve({ outcome: answer.action })
        },
      )
      if (typeof params.elicitationId === 'string') this.elicitations.set(params.elicitationId, requestId)
    })
  }

  private notice(code: string, message: string, level: 'info' | 'warning', details?: unknown, id?: string): void {
    this.ctx.emit({ type: 'agent.notice', id, code, message, level, details }, details)
  }

  /** Future-version events remain visible once. */
  private noticeOnce(key: string, message: string, details: unknown): void {
    if (this.noticed.has(key)) return
    this.noticed.add(key)
    this.notice(key, message, 'info', details, `grok-notice:${key}`)
  }

  // ─── Turns ───────────────────────────────────────────────────────────────────

  /** Turn body. Grok announces `image: false` but reads image blocks its TUI sends. Mentioned files become `file://` links expanded like `@path`; other attachments remain textual paths. */
  private promptBlocks(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): AcpContentBlock[] {
    const { promptText } = describeOutgoingMessage(text, attachments)
    const blocks: AcpContentBlock[] = []
    if (promptText) blocks.push({ type: 'text', text: promptText })
    for (const mention of mentions) {
      blocks.push({ type: 'resource_link', name: mention.relativePath, uri: pathToFileURL(mention.path).href })
    }
    for (const attachment of attachments) {
      if (!attachment.inlineImage) continue
      try {
        blocks.push({ type: 'image', mimeType: attachment.mimeType, data: readFileSync(attachment.path).toString('base64') })
      } catch {
        blocks.push({ type: 'text', text: `Image jointe : ${attachment.path}` })
      }
    }
    return blocks
  }

  async send(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): Promise<void> {
    if (!this.client || !this.sessionId) throw new Error("La session Grok n'est pas démarrée.")
    const { blocks } = describeOutgoingMessage(text, attachments)
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })

    // Known slash commands pass unchanged for Grok expansion.
    const command = parseSlashCommand(text)
    const prompt = command && this.commandNames.has(command.name)
      ? [{ type: 'text' as const, text }]
      : this.promptBlocks(text, attachments, mentions)
    this.beginTurn()
    void this.runPrompt(prompt)
  }

  private beginTurn(): void {
    this.turnActive = true
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
  }

  private async runPrompt(prompt: AcpContentBlock[]): Promise<void> {
    const client = this.client
    if (!client) return
    try {
      const response = await client.request<PromptResponse>('session/prompt', { sessionId: this.sessionId, prompt }, null)
      const meta = fields(response._meta)
      // Permission rejections end turns as `cancelled`: rejection, not interruption.
      const stopReason = meta.cancellationCategory === 'PermissionRejected' ? 'permission_denied' : response.stopReason
      this.endTurn(stopReason, meta.usage as PromptUsage | undefined, response)
    } catch (error) {
      // Process death is reported through onProcessExit.
      if (!this.client) return
      this.ctx.emit({
        type: 'error',
        code: 'turn_failed',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      })
      this.endTurn('failed', undefined, null)
    }
  }

  private endTurn(stopReason: string, usage: PromptUsage | undefined, raw: unknown): void {
    if (!this.turnActive) return
    this.turnActive = false
    this.clearCancelWatchdog()
    this.closeText()
    for (const [id] of this.tools) {
      this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: 'Tool execution aborted', isError: true, durationMs: this.durations.stop(id) })
    }
    this.tools.clear()
    this.interactions.expireAll()

    this.ctx.emit(
      {
        type: 'turn.completed',
        stopReason: stopReason === 'end_turn' ? 'completed' : stopReason === 'cancelled' ? 'interrupted' : stopReason,
        costUsd: (usage?.costUsdTicks ?? 0) * USD_PER_TICK,
        // Grok `inputTokens` includes cache usage reported separately;
        // journals separate both like other CLIs.
        inputTokens: Math.max(0, (usage?.inputTokens ?? 0) - (usage?.cachedReadTokens ?? 0)),
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cachedReadTokens ?? 0,
        cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
      },
      raw,
    )
    this.ctx.setStatus('idle')
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.sessionId || !this.turnActive) {
      this.interactions.expireAll()
      this.ctx.setStatus('idle')
      return
    }
    // Pending requests block turns. Grok drops them on cancellation,
    // so canceled responses here no longer affect anything.
    this.interactions.expireAll()
    this.client.notify('session/cancel', { sessionId: this.sessionId })
    // `session/prompt` canceled responses end turns;
    // safeguards cover responses that never arrive.
    this.clearCancelWatchdog()
    this.cancelWatchdog = setTimeout(() => this.endTurn('cancelled', undefined, null), CANCEL_GRACE_MS)
    this.cancelWatchdog.unref()
  }

  private clearCancelWatchdog(): void {
    if (this.cancelWatchdog) clearTimeout(this.cancelWatchdog)
    this.cancelWatchdog = null
  }

  /** Steers through `_x.ai/interject`, injecting text at the next safe point (probed). Another `session/prompt` would queue until completion. Attachments use paths. */
  async steer(text: string, attachments: OutgoingAttachment[]): Promise<boolean> {
    if (!this.client || !this.sessionId || !this.turnActive) return false
    const { blocks, promptText } = describeOutgoingMessage(text, attachments.map((attachment) => ({ ...attachment, inlineImage: false })))
    await this.client.request('_x.ai/interject', { sessionId: this.sessionId, text: promptText })
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    return true
  }

  /** Compacts through `_x.ai/compact_conversation`, responding after summary persistence. `auto_compact_completed` reports before/after sizes. */
  async compact(): Promise<boolean> {
    const client = this.client
    if (!client || !this.sessionId || this.turnActive) return false
    this.compacting = 'manual'
    this.ctx.emit({ type: 'context.compaction_started' })
    client.request('_x.ai/compact_conversation', { sessionId: this.sessionId }, null).then(
      () => {
        if (this.compacting !== 'manual') return
        this.compacting = null
        this.ctx.emit({ type: 'context.compacted', trigger: 'manual', preTokens: null, postTokens: null })
      },
      (err: unknown) => {
        if (!this.client) return
        this.compacting = null
        this.notice('compaction_failed', `La compaction a échoué : ${err instanceof Error ? err.message : String(err)}`, 'warning')
      },
    )
    return true
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

  reviewPlan(requestId: string, review: PlanReview): boolean {
    return this.interactions.resolvePlanReview(requestId, review)
  }

  /** Grok stops background work through model tools, not client requests. */
  async stopBackgroundTask(): Promise<boolean> {
    return false
  }

  /** Model, effort and permission modes change live; web tools, skills and MCP require fresh processes. */
  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'grok' || !this.launched || !this.client || !this.sessionId) return false
    if (!sameLaunch(this.launchFor(config), this.launched)) return false
    if (JSON.stringify(this.ctx.resolveMcpServers(config).servers) !== this.launchedMcp) return false
    // Accounts are process `GROK_HOME` and require restarting to change.
    if (config.account !== this.config.account) return false
    try {
      await this.applySessionOptions(config)
      if (config.permissionMode !== this.config.permissionMode) await this.applyPermissionMode(config.permissionMode)
    } catch {
      return false
    }
    this.config = config
    return true
  }

  /** Libraries arrive through `--plugin-dir`; `_x.ai/plugins/reload` reloads without session restarts. Failures preserve old skills and go to logs rather than conversations. */
  async reloadSkillLibrary(): Promise<void> {
    if (!this.client) return
    await this.client.request('_x.ai/plugins/reload', { sessionId: this.sessionId }).catch((err: unknown) => {
      process.stderr.write(`[grok ${this.conversationId}] relecture des skills impossible : ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }

  async suggestedTitle(): Promise<string | null> {
    return this.suggested
  }

  async stop(): Promise<void> {
    this.clearCancelWatchdog()
    const client = this.client
    this.client = null
    this.interactions.expireAll()
    client?.close()
  }
}

/** Completed tool display: command output, returned text or model-facing Grok output. `rawOutput` is a Rust enum (`{type: "SearchReplace", EditsApplied: {…, tool_output_for_prompt}}`), storing model text beneath variant keys when present. */
function toolOutput(update: { rawOutput?: unknown; content?: unknown }, track: ToolTrack): unknown {
  if (track.output) return track.output
  const text = contentText(update.content)
  if (text) return text
  const raw = fields(update.rawOutput)
  if (typeof raw.output_for_prompt === 'string') return raw.output_for_prompt
  for (const value of Object.values(raw)) {
    const variant = fields(value)
    for (const key of ['tool_output_for_prompt', 'content', 'OkayOutput']) {
      if (typeof variant[key] === 'string' && variant[key]) return variant[key]
    }
  }
  return update.rawOutput ?? ''
}
