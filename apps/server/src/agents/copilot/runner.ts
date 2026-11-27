import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ContentBlock as AcpContent, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { parseSlashCommand, type AgentConfig, type ContentBlock, type CopilotConfig, type McpServerStatus } from '@sillage/protocol'
import { AcpClient, AcpRpcError } from '../acp/client.js'
import { diffsOf, fields, type AcpDiff } from '../acp/content.js'
import { toAcpMcpServer } from '../acp/mcp.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { PendingInteractions } from '../interactions.js'
import { failedStatuses } from '../mcp-registry.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { toWorkspacePath } from '../paths.js'
import { agentProcessEnv } from '../process-env.js'
import { journalDeath } from '../session-close.js'
import { parseSkillMarkdown } from '../../skill-library/frontmatter.js'
import { ToolDurations } from '../tool-durations.js'
import { TurnLifecycle } from '../turn-lifecycle.js'
import type { AgentRunner, ElicitationAnswer, OutgoingAttachment, OutgoingMention, PermissionDecision, PlanReview, QuestionAnswer, RunnerContext } from '../types.js'
import { configOption, copilotCommands, effortOption } from './catalog.js'
import { copilotLaunch, instructionsFile, modeOf, modeValue, sameLaunch, skillDirs, type CopilotLaunch } from './launch.js'
import { describeCopilotTool, outputOf } from './tools.js'

interface ToolTrack { update: Record<string, unknown>; input: string; output: string; diffs: AcpDiff[] }

/** GitHub Copilot CLI over plain ACP (`copilot --acp`), probed on 1.0.116. */
export class CopilotRunner implements AgentRunner {
  readonly conversationId: string
  private config: CopilotConfig
  private client: AcpClient | null = null
  private sessionId: string | null
  private readonly interactions: PendingInteractions
  private readonly turn: TurnLifecycle
  private readonly durations = new ToolDurations()
  private readonly tools = new Map<string, ToolTrack>()
  private open: { id: string; kind: 'text' | 'thinking'; text: string } | null = null
  /** Notifications that arrive before the session ID is known. */
  private early: [string, unknown][] | null = []
  /** `session/load` replays the whole history before answering; it is already journaled. */
  private loading = false
  private options: unknown = {}
  private commands = new Set<string>()
  private skills = new Map<string, string>()
  private suggested: string | null = null
  private launched: CopilotLaunch | null = null
  private launchedMcp = ''
  private refresh = false
  private mcp: McpServerStatus[] = []
  private readonly noticed = new Set<string>()

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as CopilotConfig
    this.sessionId = ctx.resumeSessionId
    this.interactions = new PendingInteractions(ctx)
    this.turn = new TurnLifecycle(ctx, this.interactions)
  }

  get appliedConfig(): AgentConfig { return this.config }

  /** Private per-conversation folder Copilot reads instructions from (`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`). */
  private get instructionsRoot(): string {
    return join(tmpdir(), 'sillage-copilot', this.conversationId)
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

  async start(): Promise<void> {
    this.early = []
    const launch = this.launchFor(this.config, this.writeInstructions(this.config))
    this.launched = launch
    this.skills = new Map(skillDirs(this.ctx.skillRoots(this.config)).flatMap((dir) => {
      try {
        const { data } = parseSkillMarkdown(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
        return [[typeof data.name === 'string' ? data.name : dir.split(/[\\/]/).at(-1)!, join(dir, 'SKILL.md')] as const]
      } catch { return [] }
    }))
    const resolved = this.ctx.resolveMcpServers(this.config)
    this.launchedMcp = JSON.stringify(resolved.servers)
    const client = new AcpClient({
      label: 'copilot', binary: this.ctx.binary, args: launch.args, cwd: this.ctx.cwd,
      env: agentProcessEnv({ ...launch.env, ...this.ctx.processEnv }),
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => {
        if (method === 'session/request_permission') return this.permission(params as RequestPermissionRequest)
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
    await client.initialize(CLIENT_INFO)
    const mcpServers = resolved.servers.map(toAcpMcpServer)
    let session: Record<string, unknown>
    if (this.sessionId) {
      this.loading = true
      try {
        session = fields(await client.request('session/load', { sessionId: this.sessionId, cwd: this.ctx.cwd, mcpServers }, 90_000))
      } finally { this.loading = false }
    } else {
      session = fields(await client.request('session/new', { cwd: this.ctx.cwd, mcpServers }, 90_000))
      if (typeof session.sessionId !== 'string') throw new Error('GitHub Copilot did not return a session ID.')
      this.sessionId = session.sessionId
    }
    this.ctx.setAgentSessionId(this.sessionId)
    this.options = session
    await this.applyOptions(this.config, this.ctx.resumeSessionId !== null)
    this.ctx.emit({ type: 'session.started', agent: 'copilot', agentSessionId: this.sessionId, model: String(configOption(this.options, 'model').currentValue ?? this.config.model), cwd: this.ctx.cwd, tools: [] }, session)
    // Copilot sends no MCP health notification; a successful call confirms the connection.
    this.mcp = [...failedStatuses(resolved.failures), ...resolved.servers.map((server) => ({ name: server.name, state: 'configured' as const, tools: [], error: null, external: false }))]
    this.ctx.emit({ type: 'mcp.updated', servers: this.mcp })
    this.ctx.emit({ type: 'skills.updated', skills: [...this.skills.keys()].map((name) => ({ name, description: '' })) })
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
    // In this order: the effort option exists only once a model that has one is selected.
    const wanted: [() => unknown, string][] = [
      [() => 'model', config.model],
      [() => effortOption(this.options).id, config.reasoningEffort],
      [() => 'mode', config.mode ? modeValue(config.mode) : ''],
      [() => 'allow_all', config.allowAll],
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
    if (this.loading && method === 'session/update' && !['available_commands_update', 'config_option_update', 'current_mode_update'].includes(String(fields(fields(params).update).sessionUpdate))) return
    if (this.early) { this.early.push([method, params]); return }
    if (method !== 'session/update') { this.notice(method, `GitHub Copilot: ${method}`, params); return }
    const notification = fields(params)
    if (notification.sessionId !== this.sessionId) return
    const update = fields(notification.update)
    const kind = update.sessionUpdate
    if (kind === 'available_commands_update') {
      const commands = copilotCommands(update.availableCommands)
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
      if (content.type === 'text') this.append(kind === 'agent_message_chunk' ? 'text' : 'thinking', String(content.text ?? ''))
      else this.richContent(content)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.closeText()
      this.tool(update, params)
    } else if (kind === 'plan') {
      this.ctx.emit({ type: 'plan.updated', items: (Array.isArray(update.entries) ? update.entries : []).map((entry) => ({ text: String(fields(entry).content), status: fields(entry).status as 'pending' | 'in_progress' | 'completed' })) })
    } else if (kind === 'usage_update') {
      const used = Number(update.used), size = Number(update.size)
      if (Number.isFinite(used) && size > 0) this.ctx.emit({ type: 'usage.updated', costUsd: 0, inputTokens: 0, outputTokens: 0, context: { usedTokens: used, maxTokens: size, ratio: Math.min(1, used / size) }, rateLimit: null }, params)
    } else if (kind === 'session_info_update') {
      if (typeof update.title === 'string') this.suggested = update.title
    } else if (kind !== 'user_message_chunk') {
      this.notice(String(kind), `GitHub Copilot: ${String(kind)}`, params)
    }
  }

  private append(kind: 'text' | 'thinking', text: string): void {
    if (!text) return
    if (this.open?.kind !== kind) this.closeText()
    this.open ??= { id: randomUUID(), kind, text: '' }
    this.open.text += text
    this.ctx.emit({ type: kind === 'text' ? 'message.delta' : 'thinking.delta', messageId: this.open.id, text, parentToolCallId: null })
  }

  private closeText(): void {
    const open = this.open
    this.open = null
    if (open?.text.trim()) this.ctx.emit({ type: 'message.completed', messageId: open.id, role: 'assistant', blocks: [{ type: open.kind, text: open.text }], parentToolCallId: null })
  }

  private richContent(content: Record<string, unknown>): void {
    this.closeText()
    let block: ContentBlock | null = null
    if (content.type === 'image' && typeof content.data === 'string' && typeof content.mimeType === 'string') block = { type: 'image', mimeType: content.mimeType, url: `data:${content.mimeType};base64,${content.data}` }
    if (content.type === 'resource' && typeof fields(content.resource).text === 'string') block = { type: 'text', text: String(fields(content.resource).text) }
    if (content.type === 'resource_link') block = { type: 'text', text: `${String(content.name ?? '')}: ${String(content.uri ?? '')}` }
    if (block) this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'assistant', blocks: [block], parentToolCallId: null })
  }

  private tool(update: Record<string, unknown>, raw: unknown): void {
    const id = String(update.toolCallId)
    let track = this.tools.get(id)
    // A closing frame for a call Sillage never saw open (closed already, or announced before a
    // restart) has nothing to attach to.
    if (!track && update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) return
    const merged = { ...track?.update, ...update }
    const described = describeCopilotTool(merged)
    const input = JSON.stringify([described.input, described.title])
    if (!track) {
      track = { update: merged, input, output: '', diffs: [] }
      this.tools.set(id, track)
      this.durations.start(id)
      this.ctx.emit({ type: 'tool.started', toolCallId: id, ...described, parentToolCallId: null }, raw)
    } else if (input !== track.input) {
      this.ctx.emit({ type: 'tool.input_updated', toolCallId: id, input: described.input, title: described.title }, raw)
      track.input = input
    }
    track.update = merged
    const diffs = diffsOf(update.content)
    if (diffs.length) track.diffs = diffs
    const output = outputOf(update)
    if (output && output.startsWith(track.output) && output.length > track.output.length) {
      this.ctx.emit({ type: 'tool.output_delta', toolCallId: id, chunk: output.slice(track.output.length) })
      track.output = output
    }
    if (update.status !== 'completed' && update.status !== 'failed') return
    const isError = update.status === 'failed'
    const mcp = fields(fields(merged._meta).mcp)
    if (!isError && typeof mcp.server === 'string' && typeof mcp.tool === 'string') this.mcpCalled(mcp.server, mcp.tool)
    this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: output || track.output, isError, durationMs: this.durations.stop(id) }, { update: merged, diffs: track.diffs })
    if (!isError) for (const diff of track.diffs) this.ctx.emit({ type: 'file.edited', toolCallId: id, path: toWorkspacePath(this.ctx.cwd, diff.path), action: diff.oldText === null || diff.oldText === '' ? 'created' : 'modified' })
    this.tools.delete(id)
  }

  private mcpCalled(name: string, tool: string): void {
    let server = this.mcp.find((entry) => entry.name === name)
    if (!server) { server = { name, state: 'connected', tools: [], error: null, external: true }; this.mcp.push(server) }
    server.state = 'connected'
    if (!server.tools.includes(tool)) server.tools.push(tool)
    this.ctx.emit({ type: 'mcp.updated', servers: structuredClone(this.mcp) })
  }

  private permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.loading || request.sessionId !== this.sessionId) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const call = request.toolCall
    // The request carries the edit as a diff, richer than the patch string announced first.
    const described = describeCopilotTool({ ...this.tools.get(call.toolCallId)?.update, ...(call as unknown as Record<string, unknown>) })
    return new Promise((resolve) => {
      this.interactions.requestPermission({
        toolName: described.name, input: described.input, title: described.title ?? call.title ?? null, description: null,
        suggestions: request.options.map((option) => ({ id: option.optionId, label: option.name, scope: option.kind.endsWith('always') ? 'session' as const : 'once' as const, behavior: option.kind.startsWith('allow') ? 'allow' as const : 'deny' as const })),
      }, (decision) => {
        if (!decision) { resolve({ outcome: { outcome: 'cancelled' } }); return }
        const wanted = decision.decision === 'denied' ? ['reject_once', 'reject_always'] : decision.scope === 'once' ? ['allow_once'] : ['allow_always', 'allow_once']
        const option = wanted.map((kind) => request.options.find((entry) => entry.kind === kind)).find(Boolean)
        resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } })
      })
    })
  }

  async send(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[] = []): Promise<void> {
    if (this.turn.open) throw new Error('GitHub Copilot already has an active turn.')
    if (this.refresh || !this.client) {
      const old = this.client; this.client = null; await old?.closeAndWait()
      await this.start(); this.refresh = false
    }
    const { promptText } = describeOutgoingMessage(text, attachments, this.ctx.sessionReferenceContext?.(text, this.config))
    const command = parseSlashCommand(text)
    const native = command !== null && this.commands.has(command.name)
    const prompt: AcpContent[] = [{ type: 'text', text: native ? text : promptText }]
    if (!native) {
      for (const name of skills) {
        const path = this.skills.get(name)
        if (path) prompt.push({ type: 'resource', resource: { uri: pathToFileURL(path).href, mimeType: 'text/markdown', text: readFileSync(path, 'utf8') } })
      }
      for (const mention of mentions) prompt.push({ type: 'resource_link', name: mention.relativePath, uri: pathToFileURL(mention.path).href })
      for (const attachment of attachments) {
        if (attachment.inlineImage) prompt.push({ type: 'image', mimeType: attachment.mimeType, data: readFileSync(attachment.path).toString('base64') })
        else prompt.push({ type: 'resource_link', name: attachment.filename, uri: pathToFileURL(attachment.path).href, mimeType: attachment.mimeType })
      }
    }
    const token = this.turn.begin()
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

  private endTurn(response: Record<string, unknown>, raw: unknown, token?: number): void {
    const usage = fields(response.usage)
    this.turn.end({
      stopReason: response.stopReason === 'end_turn' ? 'completed' : response.stopReason === 'cancelled' ? 'interrupted' : String(response.stopReason ?? 'completed'),
      usage: { costUsd: 0, inputTokens: Number(usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0) + Number(usage.thoughtTokens ?? 0), cacheReadTokens: Number(usage.cachedReadTokens ?? 0), cacheCreationTokens: Number(usage.cachedWriteTokens ?? 0) },
      raw,
      close: () => {
        this.closeText()
        for (const id of this.tools.keys()) {
          this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: 'Tool execution interrupted', isError: true, durationMs: this.durations.stop(id) })
        }
        this.tools.clear()
      },
    }, token)
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
    await this.applyOptions(config)
    this.config = config
    this.syncOptions()
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
  async compact(): Promise<boolean> { return false }
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
