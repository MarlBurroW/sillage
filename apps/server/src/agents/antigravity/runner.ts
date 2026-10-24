import { antigravitySkills } from './skills.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ContentBlock as AcpContent, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { antigravityPermissionModeSchema, parseSlashCommand, type AgentConfig, type AntigravityConfig, type ContentBlock, type McpServerStatus } from '@sillage/protocol'
import { AcpClient, AcpRpcError } from '../acp/client.js'
import { contentText, diffsOf, fields, type AcpDiff } from '../acp/content.js'
import { toSlashCommands } from '../acp/commands.js'
import { toAcpMcpServer } from '../acp/mcp.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { PendingInteractions } from '../interactions.js'
import { failedStatuses } from '../mcp-registry.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { toWorkspacePath } from '../paths.js'
import { journalDeath } from '../session-close.js'
import { ToolDurations } from '../tool-durations.js'
import type { AgentRunner, ElicitationAnswer, OutgoingAttachment, OutgoingMention, PermissionDecision, PlanReview, QuestionAnswer, RunnerContext } from '../types.js'
import { antigravityEnv, antigravitySessionHome, userAntigravityHome } from '../../antigravity-accounts/homes.js'
import { persistAntigravityArtifacts, prepareAntigravityResume, rememberAntigravityStorage } from '../../antigravity-accounts/session-storage.js'
import { antigravityArgs } from './launch.js'
import { configOption, optionsOf } from './catalog.js'
import { describeAntigravityTool } from './tools.js'

interface ToolTrack { update: Record<string, unknown>; input: string; output: string; diffs: AcpDiff[] }

/** Standard ACP with Google's system-prompt and tool metadata extensions. */
export class AntigravityRunner implements AgentRunner {
  readonly conversationId: string
  private config: AntigravityConfig
  private client: AcpClient | null = null
  private sessionId: string | null
  private readonly interactions: PendingInteractions
  private readonly durations = new ToolDurations()
  private readonly tools = new Map<string, ToolTrack>()
  private early: [string, unknown][] | null = []
  private open: { id: string; kind: 'text' | 'thinking'; text: string } | null = null
  private active = false
  private watchdog: NodeJS.Timeout | null = null
  private commands = new Set<string>()
  private suggested: string | null = null
  private launchedMcp = ''
  private refreshSkills = false
  private skills: ReturnType<typeof antigravitySkills> = new Map()
  private options: unknown = {}
  private readonly noticed = new Set<string>()
  private mcp: McpServerStatus[] = []
  private replaying = false
  private home = ''
  private readonly background = new Map<string, string>()

  async importHistory(): Promise<void> {
    this.replaying = true
    try { await this.start(); this.closeText(); this.endTurn({ stopReason: 'end_turn' }, null) }
    finally { this.replaying = false }
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as AntigravityConfig
    this.sessionId = ctx.resumeSessionId
    this.interactions = new PendingInteractions(ctx)
  }
  get appliedConfig(): AgentConfig { return this.config }

  async start(): Promise<void> {
    this.early = this.replaying ? null : []
    const home = this.ctx.processEnv?.GEMINI_HOME || userAntigravityHome()
    const storageRoot = this.ctx.processEnv?.SILLAGE_ANTIGRAVITY_SESSION_ROOT
    const view = antigravitySessionHome(home, this.conversationId, this.ctx.skillRoots(this.config))
    if (this.sessionId && storageRoot) await prepareAntigravityResume(view, storageRoot, this.sessionId, home)
    this.home = view
    this.skills = antigravitySkills(view, this.ctx.cwd)
    const env = { ...antigravityEnv(home, this.config.account !== null), ...this.ctx.processEnv, GEMINI_HOME: view }
    const resolved = this.ctx.resolveMcpServers(this.config)
    this.launchedMcp = JSON.stringify(resolved.servers)
    const client = new AcpClient({
      label: 'antigravity', binary: this.ctx.binary, args: antigravityArgs(), cwd: this.ctx.cwd, env,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => {
        if (method === 'session/request_permission') return this.permission(params as RequestPermissionRequest)
        return Promise.reject(new AcpRpcError(`Unsupported ACP client method: ${method}`, -32601))
      },
      onExit: (code) => {
        if (this.client !== client) return
        this.client = null
        this.clearWatchdog()
        this.active = false
        this.interactions.expireAll()
        this.ctx.setStatus('error')
        journalDeath(this.ctx, { type: 'error', code: 'runner_failed', message: `Antigravity stopped unexpectedly (${code ?? 'unknown'}).`, recoverable: true })
      },
    })
    this.client = client
    await client.initialize(CLIENT_INFO)
    const overview = this.ctx.projectOverview(this.config)
    if (this.replaying && this.sessionId) this.ctx.emit({ type: 'session.started', agent: 'antigravity', agentSessionId: this.sessionId, model: this.config.model, cwd: this.ctx.cwd, tools: [] })
    const session = await client.request<{ sessionId?: string }>(this.sessionId ? this.replaying ? 'session/load' : 'session/resume' : 'session/new', {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}), cwd: this.ctx.cwd,
      mcpServers: resolved.servers.map(toAcpMcpServer),
      additionalDirectories: this.config.additionalDirectories,
      _meta: { antigravity: { ...(overview ? { systemPrompt: { append: overview } } : {}) } },
    }, 90_000)
    this.sessionId = this.sessionId ?? session.sessionId ?? null
    if (!this.sessionId) throw new Error('Antigravity did not return a session ID.')
    this.ctx.setAgentSessionId(this.sessionId)
    if (storageRoot) await rememberAntigravityStorage(view, storageRoot, this.sessionId)
    this.options = session
    await this.applyOptions(this.config, this.ctx.resumeSessionId !== null)
    const selected = this.options
    if (!this.replaying) this.ctx.emit({ type: 'session.started', agent: 'antigravity', agentSessionId: this.sessionId, model: String(configOption(this.options, 'model').currentValue ?? this.config.model), cwd: this.ctx.cwd, tools: [] }, session)
    // Google exposes no MCP health notification; a successful call confirms connection.
    this.mcp = [...failedStatuses(resolved.failures), ...resolved.servers.map((server) => ({ name: server.name, state: 'configured' as const, tools: [], error: null, external: false }))]
    this.ctx.emit({ type: 'mcp.updated', servers: this.mcp })
    this.ctx.emit({ type: 'skills.updated', skills: [...this.skills.values()].map(({ name, description }) => ({ name, description })) })
    if (this.config.additionalDirectories.length) this.notice('additional_directories_unsupported', 'Antigravity 1.4.3 ignores additional workspace roots. Its native file tools remain scoped to the project.', null)
    const early = this.early
    this.early = null
    for (const [method, params] of early ?? []) this.notification(method, params)
    this.syncOptions(fields(selected))
  }

  private syncOptions(update: Record<string, unknown>): void {
    this.options = update
    const mode = antigravityPermissionModeSchema.safeParse(configOption(update, 'mode').currentValue)
    const model = configOption(update, 'model').currentValue
    const effort = configOption(update, 'thinking_level').currentValue
    this.config = { ...this.config, ...(mode.success ? { permissionMode: mode.data } : {}), ...(typeof model === 'string' ? { model } : {}), ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}) }
    this.ctx.updateConfig(this.config)
  }

  private async applyOptions(config: AntigravityConfig, restoring = false): Promise<void> {
    for (const [configId, value] of [['model', config.model], ['thinking_level', config.reasoningEffort], ['mode', config.permissionMode]]) {
      if (!value || configOption(this.options, configId!).currentValue === value) continue
      const option = configOption(this.options, configId!)
      if (restoring && configId !== 'mode' && !optionsOf(option.options).some((choice) => choice.value === value)) {
        this.notice('antigravity_model_adjusted', 'The saved model or thinking level is unavailable for this account. Antigravity selected an available default.', { option: configId, requested: value, selected: option.currentValue })
        continue
      }
      this.options = await this.client!.request('session/set_config_option', { sessionId: this.sessionId, configId, value })
    }
  }

  private notification(method: string, params: unknown): void {
    if (this.early) { this.early.push([method, params]); return }
    if (method !== 'session/update') { this.notice(method, `Antigravity: ${method}`, params); return }
    const notification = fields(params)
    if (notification.sessionId !== this.sessionId) return
    const update = fields(notification.update)
    const kind = update.sessionUpdate
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = fields(update.content)
      if (content.type === 'text') this.append(kind === 'agent_message_chunk' ? 'text' : 'thinking', String(content.text ?? ''))
      else this.richContent(content)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.closeText()
      this.tool(update, params)
    } else if (kind === 'available_commands_update') {
      const commands = toSlashCommands(update.availableCommands)
      this.commands = new Set(commands.map((command) => command.name))
      this.ctx.emit({ type: 'commands.updated', commands })
    } else if (kind === 'plan') {
      this.ctx.emit({ type: 'plan.updated', items: (Array.isArray(update.entries) ? update.entries : []).map((entry) => ({ text: String(fields(entry).content), status: fields(entry).status as 'pending' | 'in_progress' | 'completed' })) })
    } else if (kind === 'usage_update') {
      const used = Number(update.used), size = Number(update.size)
      if (Number.isFinite(used) && size > 0) this.ctx.emit({ type: 'usage.updated', costUsd: 0, inputTokens: 0, outputTokens: 0, context: { usedTokens: used, maxTokens: size, ratio: Math.min(1, used / size) }, rateLimit: null }, params)
    } else if (kind === 'session_info_update') {
      if (typeof update.title === 'string') this.suggested = update.title
    } else if (kind === 'config_option_update' || kind === 'current_mode_update') {
      if (kind === 'config_option_update') this.options = update
      const mode = antigravityPermissionModeSchema.safeParse(kind === 'current_mode_update' ? update.currentModeId : configOption(update, 'mode').currentValue)
      const model = configOption(update, 'model').currentValue
      const effort = configOption(update, 'thinking_level').currentValue
      this.config = { ...this.config, ...(mode.success ? { permissionMode: mode.data } : {}), ...(typeof model === 'string' ? { model } : {}), ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}) }
      this.ctx.updateConfig(this.config)
    } else if (kind === 'user_message_chunk' && this.replaying) {
      this.closeText()
      this.endTurn({ stopReason: 'end_turn' }, null)
      this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks: [{ type: 'text', text: String(fields(update.content).text ?? '') }], parentToolCallId: null }, params)
      this.active = true
      this.ctx.emit({ type: 'turn.started' })
    } else if (kind !== 'user_message_chunk') this.notice(String(kind), `Antigravity: ${String(kind)}`, params)
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
    if (content.type === 'resource') {
      const resource = fields(content.resource)
      if (typeof resource.text === 'string') block = { type: 'text', text: resource.text }
    }
    if (content.type === 'resource_link') block = { type: 'text', text: `${String(content.name ?? '')}: ${String(content.uri ?? '')}` }
    if (block) this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'assistant', blocks: [block], parentToolCallId: null })
  }

  private tool(update: Record<string, unknown>, raw: unknown): void {
    const id = String(update.toolCallId)
    if (id.startsWith('interaction_')) return
    let track = this.tools.get(id)
    const merged = { ...track?.update, ...update }
    const described = describeAntigravityTool(merged)
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
    const combined = fields(update.rawOutput).combinedOutput
    const output = typeof update.rawOutput === 'string' ? update.rawOutput : typeof combined === 'string' ? combined : contentText(update.content)
    if (output && output.startsWith(track.output) && output.length > track.output.length) {
      this.ctx.emit({ type: 'tool.output_delta', toolCallId: id, chunk: output.slice(track.output.length) })
      track.output = output
    }
    if (update.status !== 'completed' && update.status !== 'failed') return
    const isError = update.status === 'failed'
    const mcp = fields(fields(merged._meta).mcp)
    if (!isError && typeof mcp.server === 'string' && typeof mcp.tool === 'string') {
      let server = this.mcp.find((entry) => entry.name === mcp.server)
      if (!server) { server = { name: mcp.server, state: 'connected', tools: [], error: null, external: true }; this.mcp.push(server) }
      server.state = 'connected'
      if (!server.tools.includes(mcp.tool)) server.tools.push(mcp.tool)
      this.ctx.emit({ type: 'mcp.updated', servers: structuredClone(this.mcp) })
    }
    this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: output || update.rawOutput || track.output, isError, durationMs: this.durations.stop(id) }, { update: merged, diffs: track.diffs })
    if (!isError) for (const diff of track.diffs) this.ctx.emit({ type: 'file.edited', toolCallId: id, path: toWorkspacePath(this.ctx.cwd, diff.path), action: diff.oldText === null ? 'created' : 'modified' })
    for (const item of Array.isArray(update.content) ? update.content : []) {
      const content = fields(fields(item).content)
      if (content.type === 'image') this.richContent(content)
    }
    this.tools.delete(id)
    if (this.background.delete(id)) this.publishBackground()
  }

  private publishBackground(): void {
    this.ctx.emit({ type: 'background.updated', tasks: [...this.background].map(([id, description]) => ({ id, kind: 'shell', description })) })
  }

  private permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.replaying) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    if (request.sessionId !== this.sessionId && this.sessionId !== null) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const call = request.toolCall
    return new Promise((resolve) => {
      const cancel = () => resolve({ outcome: { outcome: 'cancelled' } })
      if (call.toolCallId.startsWith('interaction_')) {
        this.interactions.requestQuestion([{ id: call.toolCallId, header: '', question: call.title ?? '', multiSelect: false, allowOther: false, secret: false, options: request.options.map((option) => ({ label: option.name, description: '', preview: null })) }], (answer) => {
          const selected = answer?.status === 'answered' ? answer.answers[call.toolCallId]?.[0] : undefined
          const option = request.options.find((entry) => entry.name === selected)
          if (option) resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
          else cancel()
        })
      } else {
        const described = describeAntigravityTool(call as unknown as Record<string, unknown>)
        const warnings = request.options.map((option) => fields(fields(option._meta)['agy.security.warning']).message).filter((value): value is string => typeof value === 'string')
        this.interactions.requestPermission({ toolName: described.name, input: described.input, title: described.title ?? call.title, description: [...new Set(warnings)].join('\n') || null, suggestions: request.options.map((option) => ({ id: option.optionId, label: option.name, scope: option.kind.endsWith('always') ? 'session' as const : 'once' as const, behavior: option.kind.startsWith('allow') ? 'allow' as const : 'deny' as const })) }, (decision) => {
          if (!decision) { cancel(); return }
          const wanted = decision.decision === 'denied' ? ['reject_once', 'reject_always'] : decision.scope === 'once' ? ['allow_once'] : ['allow_always', 'allow_once']
          const option = wanted.map((kind) => request.options.find((entry) => entry.kind === kind)).find(Boolean)
          if (option) resolve({ outcome: { outcome: 'selected', optionId: option.optionId } })
          else cancel()
        })
      }
    })
  }

  async send(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[], skills: string[] = []): Promise<void> {
    if (this.active) throw new Error('Antigravity already has an active turn.')
    if (this.refreshSkills || !this.client) {
      const old = this.client; this.client = null; await old?.closeAndWait()
      await this.start(); this.refreshSkills = false
    }
    // Native document fallback reads paths with file tools. Copy only this turn's
    // attachments into its allowed home, never expose another user's uploads.
    const nativeAttachments: OutgoingAttachment[] = []
    if (attachments.length) await mkdir(join(this.home, 'attachments'), { recursive: true, mode: 0o700 })
    for (const attachment of attachments) {
      const dest = join(this.home, 'attachments', basename(attachment.path))
      await copyFile(attachment.path, dest)
      nativeAttachments.push({ ...attachment, path: dest })
    }
    const { blocks, promptText } = describeOutgoingMessage(text, nativeAttachments, this.ctx.sessionReferenceContext?.(text, this.config))
    const command = parseSlashCommand(text)
    const prompt: AcpContent[] = [{ type: 'text', text: command && this.commands.has(command.name) ? text : promptText }]
    if (!command || !this.commands.has(command.name)) {
      for (const name of skills) {
        const skill = this.skills.get(name)
        if (skill) prompt.push({ type: 'resource', resource: { uri: pathToFileURL(skill.path).href, mimeType: 'text/markdown', text: readFileSync(skill.path, 'utf8') } })
      }
      for (const mention of mentions) prompt.push({ type: 'resource_link', name: mention.relativePath, uri: pathToFileURL(mention.path).href })
      for (const attachment of nativeAttachments) {
        if (attachment.inlineImage) prompt.push({ type: 'image', mimeType: attachment.mimeType, data: readFileSync(attachment.path).toString('base64') })
        else if (attachment.mimeType.startsWith('audio/')) prompt.push({ type: 'audio', mimeType: attachment.mimeType, data: readFileSync(attachment.path).toString('base64') })
        else prompt.push({ type: 'resource_link', name: attachment.filename, uri: pathToFileURL(attachment.path).href, mimeType: attachment.mimeType })
      }
    }
    this.ctx.emit({ type: 'message.completed', messageId: randomUUID(), role: 'user', blocks, parentToolCallId: null })
    this.active = true
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus('running')
    const client = this.client!
    void client.request('session/prompt', { sessionId: this.sessionId, prompt }, null).then(
      async (result) => {
        if (this.client !== client) return
        if (command?.name === 'logout') {
          await this.ctx.accountSignedOut?.()
          this.notice('antigravity_account_signed_out', 'The Google account is signed out. Choose a connected account to continue.', null)
          this.client = null
          await client.closeAndWait()
          await this.persistArtifacts()
        }
        this.endTurn(fields(result), result)
      },
      (error: unknown) => {
        if (this.client !== client) return
        this.ctx.emit({ type: 'error', code: 'turn_failed', message: error instanceof Error ? error.message : String(error), recoverable: true })
        this.endTurn({ stopReason: 'failed' }, null)
      },
    ).catch((error: unknown) => {
      this.ctx.emit({ type: 'error', code: 'account_logout_failed', message: error instanceof Error ? error.message : String(error), recoverable: true })
      this.endTurn({ stopReason: 'failed' }, null)
    })
  }
  private endTurn(response: Record<string, unknown>, raw: unknown): void {
    if (!this.active) return
    this.active = false
    this.clearWatchdog()
    this.closeText()
    for (const [id, tool] of this.tools) {
      if ((this.client && this.background.has(id)) || (response.stopReason === 'end_turn' && !this.replaying && tool.update.kind === 'execute' && tool.update.status === 'in_progress')) {
        this.background.set(id, String(tool.update.title ?? id))
        continue
      }
      this.ctx.emit({ type: 'tool.completed', toolCallId: id, output: 'Tool execution interrupted', isError: true, durationMs: this.durations.stop(id) })
      this.tools.delete(id)
      this.background.delete(id)
    }
    this.publishBackground()
    this.interactions.expireAll()
    const usage = fields(response.usage)
    this.ctx.emit({ type: 'turn.completed', stopReason: response.stopReason === 'end_turn' ? 'completed' : response.stopReason === 'cancelled' ? 'interrupted' : String(response.stopReason ?? 'completed'), costUsd: 0, inputTokens: Number(usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0) + Number(usage.thoughtTokens ?? 0), cacheReadTokens: Number(usage.cachedReadTokens ?? 0), cacheCreationTokens: Number(usage.cachedWriteTokens ?? 0) }, raw)
    this.ctx.setStatus('idle')
  }
  private clearWatchdog(): void { if (this.watchdog) clearTimeout(this.watchdog); this.watchdog = null }
  async interrupt(): Promise<void> {
    this.interactions.expireAll()
    if (!this.active) return
    this.client?.notify('session/cancel', { sessionId: this.sessionId })
    this.clearWatchdog()
    this.watchdog = setTimeout(() => {
      const client = this.client; this.client = null; client?.close()
      this.endTurn({ stopReason: 'cancelled' }, null)
    }, 15_000)
    this.watchdog.unref()
  }
  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'antigravity' || !this.client || this.active) return false
    if (config.account !== this.config.account || config.skillLibrary !== this.config.skillLibrary || JSON.stringify(config.additionalDirectories) !== JSON.stringify(this.config.additionalDirectories) || JSON.stringify(this.ctx.resolveMcpServers(config).servers) !== this.launchedMcp) return false
    await this.applyOptions(config)
    this.config = config
    this.syncOptions(fields(this.options))
    return true
  }
  async reloadSkillLibrary(): Promise<void> { this.refreshSkills = true }
  async suggestedTitle(): Promise<string | null> { return this.suggested }
  resolvePermission(id: string, decision: PermissionDecision): boolean { return this.interactions.resolvePermission(id, decision) }
  answerQuestion(id: string, answer: QuestionAnswer): boolean { return this.interactions.resolveQuestion(id, answer) }
  resolveElicitation(id: string, answer: ElicitationAnswer): boolean { return this.interactions.resolveElicitation(id, answer) }
  reviewPlan(id: string, review: PlanReview): boolean { return this.interactions.resolvePlanReview(id, review) }
  async steer(): Promise<boolean> { return false }
  async compact(): Promise<boolean> { return false }
  async stopBackgroundTask(): Promise<boolean> { return false }
  async stop(): Promise<void> {
    this.clearWatchdog()
    this.interactions.expireAll()
    const client = this.client; this.client = null
    await client?.closeAndWait()
    await this.persistArtifacts()
  }
  private async persistArtifacts(): Promise<void> {
    const root = this.ctx.processEnv?.SILLAGE_ANTIGRAVITY_SESSION_ROOT
    if (root && this.home && this.sessionId) await persistAntigravityArtifacts(this.home, root, this.sessionId)
  }
  private notice(code: string, message: string, details: unknown): void {
    if (this.noticed.has(code)) return
    this.noticed.add(code)
    this.ctx.emit({ type: 'agent.notice', code, message, level: 'info', details }, details)
  }
}
