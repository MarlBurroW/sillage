import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ContentBlock as AcpContent, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { parseElicitationFields, parseSlashCommand, type AgentConfig, type ContentBlock, type CopilotConfig, type McpServerStatus } from '@sillage/protocol'
import { AcpClient, AcpRpcError } from '../acp/client.js'
import { diffsOf, fields, type AcpDiff } from '../acp/content.js'
import { toAcpMcpServer } from '../acp/mcp.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { PendingInteractions } from '../interactions.js'
import { failedStatuses } from '../mcp-registry.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { toWorkspacePath } from '../paths.js'
import { journalDeath } from '../session-close.js'
import { parseSkillMarkdown } from '../../skill-library/frontmatter.js'
import { ToolDurations } from '../tool-durations.js'
import { TurnLifecycle, type TurnUsage } from '../turn-lifecycle.js'
import type { AgentRunner, ElicitationAnswer, OutgoingAttachment, OutgoingMention, PermissionDecision, PlanReview, QuestionAnswer, RunnerContext } from '../types.js'
import { configOption, copilotCommands, effortOption } from './catalog.js'
import { COPILOT_CLIENT_CAPABILITIES, COPILOT_EVENT_METHOD, COPILOT_META, copilotLaunch, copilotProcessEnv, explainSignIn, instructionsFile, modeOf, modeValue, sameLaunch, skillDirs, type CopilotLaunch } from './launch.js'
import { askUserQuestions } from './questions.js'
import { backgroundAgent, backgroundShell, describeCopilotTool, nativeToolRequest, outputOf, shellExit, type NativeToolRequest } from './tools.js'
import { quotaLimit, refusedLimit, type CopilotLimit, type CopilotQuota } from './usage.js'

type Fields = Record<string, unknown>
interface ToolTrack { update: Fields; name: string; input: string; output: string; diffs: AcpDiff[]; parent: string | null }
interface OpenText { id: string; kind: 'text' | 'thinking'; text: string; native: string | null }
interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Session state `session/load` announces along with the history it replays. */
const STATE_UPDATES = new Set(['available_commands_update', 'config_option_update', 'current_mode_update'])
/** Lines Copilot writes into the reply for an event it also sends as data. */
const ECHO_PREFIX: Record<string, string> = { 'session.info': 'Info', 'session.warning': 'Warning', 'session.error': 'Error' }
/** Information the journal already shows: a cancellation, a created file, a retry (`assistant.turn_retry`). */
const QUIET_INFO = new Set(['cancellation', 'file_created', 'model_retry'])
/**
 * Copilot's `session.error` categories that match a failure the other CLIs already name; the
 * rest keep the generic title, and every banner shows Copilot's own message.
 */
const ERROR_CODES: Record<string, string> = {
  authentication: 'provider_unauthorized',
  authorization: 'provider_unauthorized',
  rate_limit: 'rate_limit_exceeded',
  quota: 'usage_limit_exceeded',
  context_limit: 'context_window_exceeded',
}
/** What a permission request calls an edit, which the row already says. */
const PLAIN_REASONS = new Set(['Edit file', 'Update file', 'Create file', 'Delete file'])
const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }

function tokens(usage: Fields, cacheRead: string, cacheWrite: string): Tokens {
  const count = (key: string) => (Number.isFinite(Number(usage[key])) ? Number(usage[key]) : 0)
  return { input: count('inputTokens'), output: count('outputTokens'), cacheRead: count(cacheRead), cacheWrite: count(cacheWrite) }
}

/**
 * Copilot counts cache reads and writes inside its input, and reasoning inside its output
 * (`copilot help billing`); journals keep input and cache apart like the other CLIs.
 */
function turnUsage(spent: Tokens): TurnUsage {
  return { costUsd: 0, inputTokens: Math.max(0, spent.input - spent.cacheRead - spent.cacheWrite), outputTokens: spent.output, cacheReadTokens: spent.cacheRead, cacheCreationTokens: spent.cacheWrite }
}

export interface CopilotRunnerOptions {
  /** Sillage-owned folder for what Copilot reads from disk; see `Paths.copilot`. */
  stateDir: string
  /**
   * Receives the account quota each model call reports, the only place Copilot's ACP gives it,
   * and whether that call was billed in AI credits.
   */
  /** `home`: the extra account's `COPILOT_HOME`, empty for the machine's sign-in. */
  onQuota?: (quota: CopilotQuota, credits: boolean, home: string) => void
}

/**
 * GitHub Copilot CLI over ACP (`copilot --acp`), probed on 1.0.116 against a scripted model
 * provider. One process per conversation; a turn is a `session/prompt` request answered when
 * Copilot has finished acting on it, background work it is attached to included. Plain ACP is
 * completed by the session events subscribed at `initialize`; see `launch.ts`.
 */
export class CopilotRunner implements AgentRunner {
  readonly conversationId: string
  private config: CopilotConfig
  private client: AcpClient | null = null
  private sessionId: string | null
  private readonly interactions: PendingInteractions
  private readonly turn: TurnLifecycle
  private readonly durations = new ToolDurations()
  private readonly tools = new Map<string, ToolTrack>()
  /** Native names announced by `assistant.message` for calls whose frame has not closed. */
  private readonly natives = new Map<string, NativeToolRequest>()
  /** Sub-agent ID to the `task` call that spawned it. */
  private readonly agents = new Map<string, string>()
  private lastSpawn: string | null = null
  /** Text being streamed, per thread: the main one (`''`) and one per spawning call. */
  private readonly streams = new Map<string, OpenText>()
  /** Shells left running in the background, by Copilot's shell ID. */
  private readonly background = new Map<string, { id: string; description: string }>()
  /**
   * Lines Copilot may write into the reply for an event it also sent as data, with the notice a
   * line stands for; null when the journal already shows it.
   */
  private readonly echoes = new Map<string, (() => void) | null>()
  /** Notifications that arrive before the session ID is known. */
  private early: [string, unknown][] | null = []
  /** `session/load` replays the whole history before answering; on a resume it is already journaled. */
  private loading = false
  /** An adopted native session is being journaled from that replay. */
  private replaying = false
  private options: unknown = {}
  private commands = new Set<string>()
  private listed = ''
  private skills = new Map<string, { path: string; description: string }>()
  private suggested: string | null = null
  private launched: CopilotLaunch | null = null
  private launchedMcp = ''
  private refresh = false
  private mcp: McpServerStatus[] = []
  private readonly noticed = new Set<string>()
  /** Session events arrived: `session.idle` can then be trusted to close a turn Copilot opened. */
  private events = false
  /** Token of a turn Copilot started by itself, when background work reported back. */
  private wake: number | null = null
  /** The prompt response counts tokens since the process started: what it said last. */
  private counted: Tokens = NO_TOKENS
  /** Tokens of the model calls of the turn in progress, sub-agents included. */
  private spent: Tokens | null = null
  private failed = false
  private denied = false
  private routed: string | null = null
  private limit: CopilotLimit | null = null
  private compacting: Promise<void> | null = null
  /** A manual compaction's own events: whether Copilot announced its start and its end. */
  private compaction: { started: boolean; done: boolean } | null = null
  private compactionTrigger: unknown = undefined

  constructor(private readonly ctx: RunnerContext, private readonly runnerOptions: CopilotRunnerOptions) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as CopilotConfig
    this.sessionId = ctx.resumeSessionId
    this.interactions = new PendingInteractions(ctx)
    this.turn = new TurnLifecycle(ctx, this.interactions)
  }

  get appliedConfig(): AgentConfig { return this.config }

  /**
   * Private per-conversation folder Copilot reads instructions from
   * (`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`). Under Sillage's data directory rather than the system
   * temporary one, which other local accounts can write to first.
   */
  private get instructionsRoot(): string {
    return join(this.runnerOptions.stateDir, 'instructions', this.conversationId)
  }

  private writeInstructions(config: CopilotConfig): string | null {
    const overview = this.ctx.projectOverview(config)
    const root = this.instructionsRoot
    if (!overview) { rmSync(root, { recursive: true, force: true }); return null }
    const dir = join(root, '.github', 'instructions')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'sillage.instructions.md'), instructionsFile(overview), { mode: 0o600 })
    return root
  }

  private launchFor(config: CopilotConfig, instructionsDir: string | null): CopilotLaunch {
    const memory = this.ctx.memoryDir()
    return copilotLaunch(config, {
      skillRoots: this.ctx.skillRoots(config),
      // Without these, Copilot asks for every path outside cwd, memory and attachments included.
      directories: [...config.additionalDirectories, ...(this.ctx.workTrees?.() ?? []), ...(memory ? [memory] : []), this.ctx.attachmentsRoot].filter((dir) => existsSync(dir)),
      instructionsDir,
    })
  }

  /** Journals an adopted native session from the history `session/load` replays, without a model request. */
  async importHistory(): Promise<void> {
    this.replaying = true
    try {
      await this.start()
      this.endTurn({ stopReason: 'end_turn' }, null)
    } finally { this.replaying = false }
  }

  async start(): Promise<void> {
    this.early = []
    this.counted = NO_TOKENS
    this.events = false
    this.wake = null
    const launch = this.launchFor(this.config, this.writeInstructions(this.config))
    this.launched = launch
    this.skills = new Map(skillDirs(this.ctx.skillRoots(this.config)).flatMap((dir) => {
      try {
        const { data } = parseSkillMarkdown(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
        return [[typeof data.name === 'string' ? data.name : dir.split(/[\\/]/).at(-1)!, { path: join(dir, 'SKILL.md'), description: typeof data.description === 'string' ? data.description : '' }] as const]
      } catch { return [] }
    }))
    const resolved = this.ctx.resolveMcpServers(this.config)
    this.launchedMcp = JSON.stringify(resolved.servers)
    const client = new AcpClient({
      label: 'copilot', binary: this.ctx.binary, args: launch.args, cwd: this.ctx.cwd,
      env: copilotProcessEnv({ ...launch.env, ...this.ctx.processEnv }),
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => {
        if (method === 'session/request_permission') return this.permission(params as RequestPermissionRequest)
        if (method === 'elicitation/create') return this.elicitation(fields(params))
        return Promise.reject(new AcpRpcError(`Unsupported ACP client method: ${method}`, -32601))
      },
      onExit: (code) => {
        if (this.client !== client) return
        this.client = null
        this.turn.abandon()
        this.interactions.expireAll()
        this.ctx.setStatus('error')
        journalDeath(this.ctx, { type: 'error', code: 'runner_failed', message: `GitHub Copilot stopped unexpectedly (${code ?? 'unknown'}).`, recoverable: true })
      },
    })
    this.client = client
    await client.initialize(CLIENT_INFO, COPILOT_CLIENT_CAPABILITIES)
    const mcpServers = resolved.servers.map(toAcpMcpServer)
    const open = async (method: string, params: Fields): Promise<Fields> => {
      try { return fields(await client.request(method, { ...params, cwd: this.ctx.cwd, mcpServers }, 90_000)) }
      catch (error) { throw explainSignIn(error, Boolean(this.ctx.processEnv?.COPILOT_HOME)) }
    }
    let session: Fields
    if (this.sessionId) {
      // A resume drops the replay as it arrives; an import keeps it in the early buffer.
      this.loading = !this.replaying
      try {
        session = await open('session/load', { sessionId: this.sessionId })
      } finally { this.loading = false }
    } else {
      session = await open('session/new', {})
      if (typeof session.sessionId !== 'string') throw new Error('GitHub Copilot did not return a session ID.')
      this.sessionId = session.sessionId
    }
    this.ctx.setAgentSessionId(this.sessionId)
    this.options = session
    // An adopted session keeps the settings it was left with; they are read back below.
    if (!this.replaying) await this.applyOptions(this.config, this.ctx.resumeSessionId !== null)
    this.ctx.emit({ type: 'session.started', agent: 'copilot', agentSessionId: this.sessionId, model: String(configOption(this.options, 'model').currentValue ?? this.config.model), cwd: this.ctx.cwd, tools: [] }, session)
    // Health arrives as session events; until one does, a server is only known to be configured.
    this.mcp = [...failedStatuses(resolved.failures), ...resolved.servers.map((server) => ({ name: server.name, state: 'configured' as const, tools: [], error: null, external: false }))]
    this.ctx.emit({ type: 'mcp.updated', servers: structuredClone(this.mcp) })
    this.ctx.emit({ type: 'skills.updated', skills: [...this.skills].map(([name, skill]) => ({ name, description: skill.description })) })
    const early = this.early
    this.early = null
    for (const [method, params] of early) this.notification(method, params)
    this.syncOptions()
  }

  /** Reflects the session's options in the conversation config, so settings and resume agree with Copilot. */
  private syncOptions(): void {
    const mode = modeOf(configOption(this.options, 'mode').currentValue)
    const model = configOption(this.options, 'model').currentValue
    const allowAll = configOption(this.options, 'allow_all').currentValue
    const effort = effortOption(this.options).currentValue
    this.config = {
      ...this.config,
      ...(mode ? { mode } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(allowAll === 'off' || allowAll === 'auto' || allowAll === 'on' ? { allowAll } : {}),
      ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
    }
    this.ctx.updateConfig(this.config)
  }

  private async applyOptions(config: CopilotConfig, restoring = false): Promise<void> {
    // In this order. The effort option exists only once a model that has one is selected. The mode
    // comes last because entering Autopilot turns `allow_all` on and leaving it turns it back off
    // (probed on 1.0.116): set before, the saved permission would undo what the mode just did.
    const wanted: [() => unknown, string][] = [
      [() => 'model', config.model],
      [() => effortOption(this.options).id, config.reasoningEffort],
      [() => 'allow_all', config.allowAll],
      [() => 'mode', config.mode ? modeValue(config.mode) : ''],
    ]
    for (const [id, value] of wanted) {
      const configId = id()
      if (typeof configId !== 'string' || !value) continue
      const option = configOption(this.options, configId)
      if (option.currentValue === value) continue
      try {
        this.options = await this.client!.request('session/set_config_option', { sessionId: this.sessionId, configId, value })
      } catch (error) {
        if (!(error instanceof AcpRpcError)) throw error
        // A plan change can remove a saved model: Copilot keeps its own choice, and says so.
        this.notice('copilot_model_adjusted', 'The saved model or effort is not available for this GitHub Copilot account. Copilot kept an available one.', { option: configId, requested: value, selected: option.currentValue, restoring })
      }
    }
  }

  private notification(method: string, params: unknown): void {
    // The replay arrives while the early buffer is still filling: drop it there, keeping only
    // the session state it also announces.
    if (this.loading && method === 'session/update' && !STATE_UPDATES.has(String(fields(fields(params).update).sessionUpdate))) return
    if (this.early) { this.early.push([method, params]); return }
    if (method === COPILOT_EVENT_METHOD) { this.sessionEvent(fields(params)); return }
    if (method !== 'session/update') { this.notice(method, `GitHub Copilot: ${method}`, params); return }
    const notification = fields(params)
    if (notification.sessionId !== this.sessionId) return
    const update = fields(notification.update)
    const kind = update.sessionUpdate
    if (kind === 'available_commands_update') {
      const commands = copilotCommands(update.availableCommands)
      // Copilot announces the same list several times at startup.
      const listed = JSON.stringify(commands)
      if (listed === this.listed) return
      this.listed = listed
      this.commands = new Set(commands.map((command) => command.name))
      this.ctx.emit({ type: 'commands.updated', commands })
      return
    }
    if (kind === 'config_option_update') {
      this.options = update
      this.syncOptions()
      return
    }
    if (kind === 'current_mode_update') {
      const mode = modeOf(update.currentModeId)
      if (mode) { this.config = { ...this.config, mode }; this.ctx.updateConfig(this.config) }
      return
    }
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = fields(update.content)
      const parent = this.parentOf(update)
      if (content.type !== 'text') { this.richContent(content, parent); return }
      const chunk = String(content.text ?? '')
      const native = text(update.messageId)
      // Only the model's own chunks carry a message ID: the rest is Copilot speaking, to repeat an
      // event or to confirm a manual compaction, which the journal shows on its own.
      if (!native && (this.compacting || this.isEcho(chunk))) return
      this.wakeUp(parent)
      this.append(kind === 'agent_message_chunk' ? 'text' : 'thinking', chunk, parent, native)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.tool(update, params)
    } else if (kind === 'plan') {
      this.ctx.emit({ type: 'plan.updated', items: (Array.isArray(update.entries) ? update.entries : []).map((entry) => ({ text: String(fields(entry).content), status: fields(entry).status as 'pending' | 'in_progress' | 'completed' })) })
    } else if (kind === 'usage_update') {
      const used = Number(update.used), size = Number(update.size)
      if (Number.isFinite(used) && size > 0) this.ctx.emit({ type: 'usage.updated', costUsd: 0, inputTokens: 0, outputTokens: 0, context: { usedTokens: used, maxTokens: size, ratio: Math.min(1, used / size) }, rateLimit: null }, params)
    } else if (kind === 'session_info_update') {
      if (typeof update.title === 'string') this.suggested = update.title
    } else if (kind === 'user_message_chunk') {
      if (this.replaying) this.replayedPrompt(fields(update.content), params)
    } else {
      this.notice(String(kind), `GitHub Copilot: ${String(kind)}`, params)
    }
  }

  /** A prompt of the adopted session: closes the turn before it and opens its own. */
  private replayedPrompt(content: Fields, raw: unknown): void {
    this.endTurn({ stopReason: 'end_turn' }, null)
    this.failed = false
    this.denied = false
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks: [{ type: 'text', text: String(content.text ?? '') }], parentToolCallId: null }, raw)
    // Replayed history: the turn is journaled, the conversation is not working.
    this.turn.begin({ status: false })
  }

  /** One subscribed session event; see `COPILOT_SESSION_EVENTS`. */
  private sessionEvent(event: Fields): void {
    if (event.sessionId !== this.sessionId) return
    this.events = true
    const data = fields(event.data)
    const agentId = text(event.agentId)
    switch (event.type) {
      case 'assistant.turn_start':
        if (agentId && typeof data.parentToolCallId === 'string') this.agents.set(agentId, data.parentToolCallId)
        return
      case 'assistant.message':
        for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
          const native = nativeToolRequest(request)
          if (native) this.natives.set(native.toolCallId, native)
        }
        return
      case 'assistant.usage':
        this.modelCall(data, agentId)
        return
      case 'assistant.turn_retry':
        if (!agentId) this.ctx.emit({ type: 'agent.notice', id: 'api-retry', code: 'copilot_retry', message: 'GitHub Copilot is retrying the request after a transient error.', level: 'info', details: { reason: data.reason ?? null, model: data.model ?? null } }, event)
        return
      case 'session.idle':
        // A turn Sillage opened ends with its prompt response; one Copilot opened only says so here.
        if (this.wake !== null && this.turn.token === this.wake) this.endTurn({ stopReason: data.aborted === true ? 'cancelled' : 'end_turn' }, event, this.wake)
        return
      case 'session.info':
      case 'session.warning':
      case 'session.error':
        this.timeline(event.type, data, agentId, event)
        return
      case 'session.compaction_start':
        if (agentId) return
        if (this.compaction) this.compaction.started = true
        this.compactionTrigger = data.trigger
        this.ctx.emit({ type: 'context.compaction_started' }, event)
        return
      case 'session.compaction_complete': {
        if (agentId) return
        if (this.compaction) this.compaction.done = true
        const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
        // Named when the compaction starts; anything Copilot decides by itself is automatic.
        const named = data.trigger ?? this.compactionTrigger
        const trigger = named === 'manual' ? 'manual' : typeof named === 'string' ? 'auto' : 'unknown'
        if (data.success !== false) this.ctx.emit({ type: 'context.compacted', trigger, preTokens: count(data.preCompactionTokens), postTokens: count(data.postCompactionTokens) }, event)
        return
      }
      case 'session.mcp_server_status_changed':
        if (typeof data.serverName === 'string' && this.mcpState(data.serverName, data.status, data.error)) this.ctx.emit({ type: 'mcp.updated', servers: structuredClone(this.mcp) })
        return
      case 'session.mcp_servers_loaded': {
        // Sent again with every prompt: only a change is worth journaling.
        const changed = (Array.isArray(data.servers) ? data.servers : []).map((item) => {
          const server = fields(item)
          return typeof server.name === 'string' && this.mcpState(server.name, server.status, server.error)
        })
        if (changed.some(Boolean)) this.ctx.emit({ type: 'mcp.updated', servers: structuredClone(this.mcp) })
        return
      }
      default:
        // `session.mcp_server_tools_loaded` only counts tools; their names come with the calls.
        return
    }
  }

  /** Copilot writes these events into the reply too ("Info: …", "Error: …"); as data they become what they are. */
  private timeline(type: string, data: Fields, agentId: string | null, raw: unknown): void {
    const message = text(data.message)
    if (!message) return
    const line = `${ECHO_PREFIX[type]}: ${message}`
    // Information is only shown when Copilot writes it into the reply: it keeps most of it to
    // itself (routing and guidance notes sent with every session), and so does the journal.
    const shown = type === 'session.info' && !agentId && !QUIET_INFO.has(String(data.infoType))
      ? () => this.ctx.emit({ type: 'agent.notice', code: `copilot_info_${text(data.infoType) ?? 'other'}`, message, level: 'info', details: data }, raw)
      : null
    this.echoes.delete(line)
    this.echoes.set(line, shown)
    if (this.echoes.size > 8) this.echoes.delete(this.echoes.keys().next().value!)
    // A sub-agent's trouble comes back through the call that spawned it.
    if (agentId) return
    if (type === 'session.error') {
      this.failed = true
      const kind = text(data.errorType) ?? ''
      // The conversation survives: the next message starts another turn.
      this.ctx.emit({ type: 'error', code: ERROR_CODES[kind] ?? 'turn_failed', message, recoverable: true }, raw)
      if (kind === 'quota' || kind === 'rate_limit') this.ctx.emit({ type: 'usage.updated', costUsd: 0, inputTokens: 0, outputTokens: 0, context: null, rateLimit: refusedLimit(kind, this.limit) })
    } else if (type === 'session.warning') {
      this.ctx.emit({ type: 'agent.notice', code: `copilot_warning_${text(data.warningType) ?? 'other'}`, message, level: 'warning', details: data }, raw)
    }
  }

  private isEcho(chunk: string): boolean {
    const line = chunk.trim()
    if (!this.echoes.has(line)) return false
    const shown = this.echoes.get(line)
    this.echoes.delete(line)
    shown?.()
    return true
  }

  /** One model call: its tokens count for the turn, and it is the only place Copilot reports the account's quota. */
  private modelCall(data: Fields, agentId: string | null): void {
    const call = tokens(data, 'cacheReadTokens', 'cacheWriteTokens')
    if (this.spent) this.spent = { input: this.spent.input + call.input, output: this.spent.output + call.output, cacheRead: this.spent.cacheRead + call.cacheRead, cacheWrite: this.spent.cacheWrite + call.cacheWrite }
    const quota = fields(data.quotaSnapshots)
    if (Object.keys(quota).length) {
      this.runnerOptions.onQuota?.(quota as CopilotQuota, typeof fields(data.copilotUsage).totalNanoAiu === 'number', this.ctx.processEnv?.COPILOT_HOME ?? '')
      const limit = quotaLimit(quota as CopilotQuota)
      // Every model call repeats it: journal a reading only when it moved.
      if (limit && JSON.stringify(limit) !== JSON.stringify(this.limit)) { this.limit = limit; this.ctx.emit({ type: 'usage.updated', costUsd: 0, inputTokens: 0, outputTokens: 0, context: null, rateLimit: limit }) }
    }
    // Auto routes each request: say which model answered when it changes.
    if (!agentId && data.isAuto === true && typeof data.model === 'string' && data.model !== this.routed) {
      this.routed = data.model
      const model = text(data.modelDisplayName) ?? data.model
      this.ctx.emit({ type: 'agent.notice', id: 'copilot-auto-model', code: 'copilot_auto_model', message: `Auto is using ${model}.`, level: 'info', details: { model } })
    }
  }

  /** Records what Copilot says of a server; true when that changed anything. */
  private mcpState(name: string, status: unknown, error: unknown): boolean {
    const state = status === 'connected' ? 'connected' : status === 'failed' ? 'failed' : status === 'pending' ? 'pending' : status === 'disabled' ? 'disabled' : null
    if (!state) return false
    const failure = state === 'failed' ? text(error) : null
    const server = this.mcp.find((entry) => entry.name === name)
    // Servers Sillage did not pass come from Copilot's own files, or are built in (github-mcp-server).
    if (!server) { this.mcp.push({ name, state, tools: [], error: failure, external: true }); return true }
    if (server.state === state && server.error === failure) return false
    server.state = state
    server.error = failure
    return true
  }

  private mcpCalled(name: string, tool: string): void {
    let server = this.mcp.find((entry) => entry.name === name)
    if (!server) { server = { name, state: 'connected', tools: [], error: null, external: true }; this.mcp.push(server) }
    if (server.state === 'connected' && server.tools.includes(tool)) return
    server.state = 'connected'
    server.error = null
    if (!server.tools.includes(tool)) server.tools.push(tool)
    this.ctx.emit({ type: 'mcp.updated', servers: structuredClone(this.mcp) })
  }

  /** The spawning call of the sub-agent an update belongs to, null on the main thread. */
  private parentOf(update: Fields): string | null {
    const agentId = fields(fields(update._meta)[COPILOT_META]).agentId
    if (typeof agentId !== 'string') return null
    const known = this.agents.get(agentId)
    if (known) return known
    // No `assistant.turn_start` named it (replayed history): it belongs to the spawn still open,
    // or to the last one started.
    const open = [...this.tools].filter(([, track]) => track.name === 'Agent').map(([id]) => id)
    const parent = open.length === 1 ? open[0]! : this.lastSpawn
    if (parent) this.agents.set(agentId, parent)
    return parent
  }

  /**
   * Background work reports back after the turn ended (a detached shell finishing): Copilot then
   * reads the result and answers without a prompt. That is a turn of its own, closed by
   * `session.idle`; without session events nothing would close it, so none is opened.
   */
  private wakeUp(parent: string | null): void {
    if (parent !== null || this.turn.open || this.replaying || !this.events || this.compacting) return
    this.wake = this.turn.begin()
    this.spent = NO_TOKENS
    this.failed = false
    this.denied = false
  }

  private append(kind: 'text' | 'thinking', chunk: string, parent: string | null, native: string | null): void {
    if (!chunk) return
    const lane = parent ?? ''
    let open = this.streams.get(lane)
    if (open && (open.kind !== kind || (native !== null && open.native !== null && native !== open.native))) { this.closeText(parent); open = undefined }
    if (!open) { open = { id: randomUUID(), kind, text: '', native }; this.streams.set(lane, open) }
    open.text += chunk
    this.ctx.emit({ type: kind === 'text' ? 'message.delta' : 'thinking.delta', messageId: open.id, text: chunk, parentToolCallId: parent })
  }

  /** Completes the text streamed on one thread, or on all of them. */
  private closeText(parent?: string | null): void {
    for (const lane of parent === undefined ? [...this.streams.keys()] : [parent ?? '']) {
      const open = this.streams.get(lane)
      this.streams.delete(lane)
      if (open?.text.trim()) this.ctx.emit({ type: 'message.completed', messageId: open.id, role: 'assistant', blocks: [{ type: open.kind, text: open.text }], parentToolCallId: lane || null })
    }
  }

  private richContent(content: Fields, parent: string | null): void {
    this.closeText(parent)
    let block: ContentBlock | null = null
    if (content.type === 'image' && typeof content.data === 'string' && typeof content.mimeType === 'string') block = { type: 'image', mimeType: content.mimeType, url: `data:${content.mimeType};base64,${content.data}` }
    if (content.type === 'resource' && typeof fields(content.resource).text === 'string') block = { type: 'text', text: String(fields(content.resource).text) }
    if (content.type === 'resource_link') block = { type: 'text', text: `${String(content.name ?? '')}: ${String(content.uri ?? '')}` }
    if (block) this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'assistant', blocks: [block], parentToolCallId: parent })
  }

  private tool(update: Fields, raw: unknown): void {
    const id = String(update.toolCallId)
    let track = this.tools.get(id)
    const closing = update.status === 'completed' || update.status === 'failed'
    // A closing frame for a call Sillage never saw open (closed already, or announced before a
    // restart) has nothing to attach to.
    if (!track && update.sessionUpdate === 'tool_call_update' && closing) { this.natives.delete(id); return }
    const merged = { ...track?.update, ...update }
    const native = this.natives.get(id) ?? null
    const described = describeCopilotTool(merged, native)
    // The question is answered in its own card (`elicitation/create`), not shown as a tool row.
    if (described.name === 'ask_user') { if (closing) this.natives.delete(id); return }
    const input = JSON.stringify([described.input, described.title])
    if (!track) {
      const parent = this.parentOf(update)
      this.wakeUp(parent)
      this.closeText(parent)
      track = { update: merged, name: described.name, input, output: '', diffs: [], parent }
      this.tools.set(id, track)
      if (described.name === 'Agent') this.lastSpawn = id
      this.durations.start(id)
      this.ctx.emit({ type: 'tool.started', toolCallId: id, ...described, parentToolCallId: parent }, raw)
    } else if (input !== track.input) {
      this.ctx.emit({ type: 'tool.input_updated', toolCallId: id, input: described.input, title: described.title }, raw)
      track.input = input
    }
    track.update = merged
    const diffs = diffsOf(update.content)
    if (diffs.length) track.diffs = diffs
    const output = outputOf(update)
    // Streamed output is cumulative; what only arrives with the closing frame goes on `tool.completed`.
    if (!closing && output.startsWith(track.output) && output.length > track.output.length) {
      this.ctx.emit({ type: 'tool.output_delta', toolCallId: id, chunk: output.slice(track.output.length) })
      track.output = output
    }
    if (!closing) return

    const exit = shellExit(update)
    // Copilot closes a command that exited non-zero as completed: the exit code says it failed.
    const isError = update.status === 'failed' || (track.name === 'Bash' && exit !== null && exit.exitCode !== 0)
    if (fields(update.rawOutput).code === 'rejected') this.denied = true
    if (!isError && native?.mcpServer && native.mcpTool) this.mcpCalled(native.mcpServer, native.mcpTool)
    const shell = backgroundShell(update)
    if (shell) this.background.set(shell, { id, description: text(fields(merged.rawInput).description) ?? text(fields(merged.rawInput).command) ?? shell })
    const stopped = native?.name === 'stop_bash' ? text(fields(merged.rawInput).shellId) : null
    const ended = [exit?.shellId, stopped].filter((shellId): shellId is string => typeof shellId === 'string' && this.background.delete(shellId))
    // Before the turn can close: a background shell published later would look interrupted.
    if (shell || ended.length) this.publishBackground()
    const agent = backgroundAgent(update)
    if (agent) this.agents.set(agent, id)
    // A sub-agent that ran to the end has said everything; one left in the background keeps talking.
    else if (track.name === 'Agent') this.closeText(id)
    this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: output || track.output, isError, durationMs: this.durations.stop(id) }, { update: merged, diffs: track.diffs })
    if (!isError) for (const diff of track.diffs) this.ctx.emit({ type: 'file.edited', toolCallId: id, path: toWorkspacePath(this.ctx.cwd, diff.path), action: diff.oldText === null || diff.oldText === '' ? 'created' : 'modified' })
    this.tools.delete(id)
    this.natives.delete(id)
  }

  private publishBackground(): void {
    this.ctx.emit({ type: 'background.updated', tasks: [...this.background.values()].map(({ id, description }) => ({ id, kind: 'shell', description })) })
  }

  private permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.loading || this.replaying || request.sessionId !== this.sessionId) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const call = request.toolCall
    const track = this.tools.get(call.toolCallId)
    const native = this.natives.get(call.toolCallId) ?? null
    // The request renames the call ("Edit file", "Access paths outside trusted directories") and
    // replaces its arguments by a diff. The row's own description stays, the request's title says why.
    const described = describeCopilotTool(track?.update ?? (call as unknown as Fields), native)
    const reason = text(call.title)
    return new Promise((resolve) => {
      this.interactions.requestPermission({
        toolName: described.name, input: described.input, title: described.title ?? (track ? null : reason),
        description: track && reason && reason !== text(track.update.title) && reason !== native?.mcpTool && !PLAIN_REASONS.has(reason) ? reason : null,
        suggestions: request.options.map((option) => ({ id: option.optionId, label: option.name, scope: option.kind.endsWith('always') ? 'session' as const : 'once' as const, behavior: option.kind.startsWith('allow') ? 'allow' as const : 'deny' as const })),
      }, (decision) => {
        if (!decision) { resolve({ outcome: { outcome: 'cancelled' } }); return }
        // Copilot ends the whole turn on a refusal: the turn then closes as denied, not completed.
        if (decision.decision === 'denied') this.denied = true
        const wanted = decision.decision === 'denied' ? ['reject_once', 'reject_always'] : decision.scope === 'once' ? ['allow_once'] : ['allow_always', 'allow_once']
        const option = wanted.map((kind) => request.options.find((entry) => entry.kind === kind)).find(Boolean)
        resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } })
      })
    })
  }

  /** Copilot's `ask_user`: a question when the form only offers choices, a form otherwise. */
  private elicitation(params: Fields): Promise<unknown> {
    if (this.loading || this.replaying || (params.sessionId !== undefined && params.sessionId !== this.sessionId)) return Promise.resolve({ action: 'cancel' })
    const message = text(params.message) ?? ''
    if (params.mode !== undefined && params.mode !== 'form') return Promise.resolve({ action: 'decline' })
    const asked = askUserQuestions(message, params.requestedSchema)
    return new Promise((resolve) => {
      if (asked) {
        this.interactions.requestQuestion(asked.questions, (answer) => {
          resolve(answer?.status === 'answered' ? { action: 'accept', content: asked.content(answer.answers) } : { action: 'cancel' })
        })
        return
      }
      this.interactions.requestElicitation(
        { serverName: 'GitHub Copilot', mode: 'form', message, url: null, fields: parseElicitationFields(params.requestedSchema), title: null },
        (answer) => {
          if (!answer) resolve({ action: 'cancel' })
          else if (answer.action === 'accept') resolve({ action: 'accept', content: answer.content })
          else resolve({ action: answer.action })
        },
      )
    })
  }

  async send(message: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[] = []): Promise<void> {
    if (this.turn.open) throw new Error('GitHub Copilot already has an active turn.')
    // A second prompt cancels the one in progress (probed on 1.0.116): let a compaction finish.
    await this.compacting
    if (this.refresh || !this.client) {
      const old = this.client; this.client = null; await old?.closeAndWait()
      await this.start(); this.refresh = false
    }
    const { promptText } = describeOutgoingMessage(message, attachments, this.ctx.sessionReferenceContext?.(message, this.config))
    const command = parseSlashCommand(message)
    const native = command !== null && this.commands.has(command.name)
    const prompt: AcpContent[] = [{ type: 'text', text: native ? message : promptText }]
    if (!native) {
      for (const name of skills) {
        const path = this.skills.get(name)?.path
        if (path) prompt.push({ type: 'resource', resource: { uri: pathToFileURL(path).href, mimeType: 'text/markdown', text: readFileSync(path, 'utf8') } })
      }
      for (const mention of mentions) prompt.push({ type: 'resource_link', name: mention.relativePath, uri: pathToFileURL(mention.path).href })
      for (const attachment of attachments) {
        if (attachment.inlineImage) prompt.push({ type: 'image', mimeType: attachment.mimeType, data: readFileSync(attachment.path).toString('base64') })
        else prompt.push({ type: 'resource_link', name: attachment.filename, uri: pathToFileURL(attachment.path).href, mimeType: attachment.mimeType })
      }
    }
    const token = this.turn.begin()
    this.wake = null
    this.spent = NO_TOKENS
    this.failed = false
    this.denied = false
    const client = this.client!
    void client.request('session/prompt', { sessionId: this.sessionId, prompt }, null).then(
      (result) => { if (this.client === client) this.endTurn(fields(result), result, token) },
      (error: unknown) => {
        if (this.client !== client) return
        this.ctx.emit({ type: 'error', code: 'turn_failed', message: error instanceof Error ? error.message : String(error), recoverable: true })
        this.endTurn({ stopReason: 'failed' }, null, token)
      },
    )
  }

  private endTurn(response: Fields, raw: unknown, token?: number): void {
    // The response counts everything since the process started; the turn spent the difference.
    // Model calls reported as events are exact, and the only source for a turn Copilot opened.
    const total = response.usage === undefined ? null : tokens(fields(response.usage), 'cachedReadTokens', 'cachedWriteTokens')
    const since = total ? { input: total.input - this.counted.input, output: total.output - this.counted.output, cacheRead: total.cacheRead - this.counted.cacheRead, cacheWrite: total.cacheWrite - this.counted.cacheWrite } : NO_TOKENS
    const spent = this.spent && (this.spent.input || this.spent.output) ? this.spent : since
    const reason = response.stopReason === 'cancelled' ? 'interrupted'
      : response.stopReason !== 'end_turn' ? String(response.stopReason ?? 'completed')
      : this.failed ? 'failed' : this.denied ? 'permission_denied' : 'completed'
    const closed = this.turn.end({
      stopReason: reason,
      usage: turnUsage({ input: Math.max(0, spent.input), output: Math.max(0, spent.output), cacheRead: Math.max(0, spent.cacheRead), cacheWrite: Math.max(0, spent.cacheWrite) }),
      raw,
      close: () => {
        this.closeText()
        for (const id of this.tools.keys()) {
          this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: 'Tool execution interrupted', isError: true, durationMs: this.durations.stop(id) })
        }
        this.tools.clear()
        this.natives.clear()
      },
    }, token)
    if (!closed) return
    if (total) this.counted = total
    this.spent = null
    this.wake = null
  }

  async interrupt(): Promise<void> {
    if (!this.turn.open) { this.turn.settleWithoutTurn(); return }
    this.interactions.expireAll()
    this.client?.notify('session/cancel', { sessionId: this.sessionId })
    this.turn.armWatchdog(15_000, (token) => {
      const client = this.client; this.client = null; client?.close()
      this.endTurn({ stopReason: 'cancelled' }, null, token)
    })
  }

  /** Live for model, effort, mode and permissions; anything read at launch needs a restart. */
  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'copilot' || !this.client || this.turn.open || !this.launched) return false
    const launch = this.launchFor(config, this.ctx.projectOverview(config) ? this.instructionsRoot : null)
    if (!sameLaunch(launch, this.launched) || JSON.stringify(this.ctx.resolveMcpServers(config).servers) !== this.launchedMcp) return false
    // The account is the process's `COPILOT_HOME`, read at launch.
    if (config.account !== this.config.account) return false
    await this.applyOptions(config)
    this.config = config
    this.syncOptions()
    return true
  }

  /**
   * `/compact` is a slash command Copilot runs as a prompt: no RPC, but no model turn either, so
   * it is not journaled as one. Its events say when it starts and what it saved.
   */
  async compact(): Promise<boolean> {
    const client = this.client
    if (!client || this.turn.open || this.compacting || !this.commands.has('compact')) return false
    const compaction = { started: false, done: false }
    this.compaction = compaction
    const finished = client.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: '/compact' }] }, null).then(
      (result) => {
        if (this.client !== client) return
        const total = fields(result).usage === undefined ? null : tokens(fields(fields(result).usage), 'cachedReadTokens', 'cachedWriteTokens')
        if (total) this.counted = total
        // Without session events nothing announced the compaction.
        if (!compaction.started) this.ctx.emit({ type: 'context.compaction_started' })
        if (!compaction.done) this.ctx.emit({ type: 'context.compacted', trigger: 'manual', preTokens: null, postTokens: null })
      },
      (error: unknown) => {
        if (this.client === client) this.ctx.emit({ type: 'error', code: 'compact_failed', message: error instanceof Error ? error.message : String(error), recoverable: true })
      },
    ).finally(() => {
      if (this.compaction === compaction) this.compaction = null
      this.compacting = null
    })
    this.compacting = finished
    return true
  }

  async reloadSkillLibrary(): Promise<void> { this.refresh = true }
  async reconnectMcpServer(): Promise<boolean> { return false }
  async suggestedTitle(): Promise<string | null> { return this.suggested }
  resolvePermission(id: string, decision: PermissionDecision): boolean { return this.interactions.resolvePermission(id, decision) }
  answerQuestion(id: string, answer: QuestionAnswer): boolean { return this.interactions.resolveQuestion(id, answer) }
  resolveElicitation(id: string, answer: ElicitationAnswer): boolean { return this.interactions.resolveElicitation(id, answer) }
  reviewPlan(id: string, review: PlanReview): boolean { return this.interactions.resolvePlanReview(id, review) }
  async steer(): Promise<boolean> { return false }
  async stopBackgroundTask(): Promise<boolean> { return false }

  async stop(): Promise<void> {
    this.turn.dispose()
    this.interactions.expireAll()
    const client = this.client; this.client = null
    await client?.closeAndWait()
    rmSync(this.instructionsRoot, { recursive: true, force: true })
  }

  private notice(code: string, message: string, details: unknown, level: 'info' | 'warning' = 'info'): void {
    if (this.noticed.has(code)) return
    this.noticed.add(code)
    this.ctx.emit({ type: 'agent.notice', code, message, level, details }, details)
  }
}
