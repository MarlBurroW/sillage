import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { agentProcessEnv } from '../process-env.js'
import {
  CLI_DEFAULT,
  parseElicitationFields,
  type AgentConfig,
  type AgentQuestion,
  type AgentSkillDto,
  type CodexConfig,
  type ContentBlock,
  type McpServer,
  type McpServerStatus,
} from '@sillage/protocol'
import type { CollaborationMode, RequestId } from '@sillage/codex-bindings'
import type {
  AccountRateLimitsUpdatedNotification,
  AskForApproval,
  AgentMessageDeltaNotification,
  AccountUpdatedNotification,
  ConfigReadResponse,
  DeprecationNoticeNotification,
  CommandExecutionOutputDeltaNotification,
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  ErrorNotification,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  ListMcpServerStatusResponse,
  McpServerElicitationRequestParams,
  McpServerStatusUpdatedNotification,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ReasoningTextDeltaNotification,
  SandboxPolicy,
  SkillsExtraRootsSetResponse,
  SkillsListResponse,
  ThreadItem,
  ThreadNameUpdatedNotification,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
  ThreadStartedNotification,
  ThreadStatusChangedNotification,
  ThreadSettingsUpdatedNotification,
  TurnDiffUpdatedNotification,
  TerminalInteractionNotification,
  FileChangePatchUpdatedNotification,
  ServerRequestResolvedNotification,
  HookStartedNotification,
  HookCompletedNotification,
  ItemGuardianApprovalReviewStartedNotification,
  ItemGuardianApprovalReviewCompletedNotification,
  ModelReroutedNotification,
  ModelSafetyBufferingUpdatedNotification,
  ConfigWarningNotification,
  McpToolCallProgressNotification,
  WarningNotification,
  TurnStartedNotification,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from '@sillage/codex-bindings/v2'
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
import { describeOutgoingMessage } from '../outgoing.js'
import { journalDeath } from '../session-close.js'
import { ToolDurations } from '../tool-durations.js'
import { failedStatuses } from '../mcp-registry.js'
import { badRequest } from '../../http/errors.js'
import { CodexAppServerClient, CodexRpcError } from './app-server-client.js'
import { CodexAsyncQuestions } from './async-questions.js'
import { startedItem, completedItem } from './item-events.js'
import { NOTIFICATION_POLICY } from './notification-policy.js'
import { CodexSubAgentUsage, CodexTurnUsage } from './turn-usage.js'
import { CLIENT_INFO } from './client-info.js'
import { codexErrorCode, describeTurnError } from './errors.js'
import { fromCodexMcpStatus, toCodexThreadConfig, type CodexMcpStartup } from './mcp.js'
import { describeWindow } from './quota.js'
import { detach } from '../../detach.js'

/**
 * Codex adapter (invariant I3) translates app-server to shared events so frontend need not
 * distinguish Claude. Structurally, Codex accepts model, effort, approval, and sandbox on every
 * turn, allowing setting changes without process restart.
 */

/**
 * turn/start supports collaboration mode behind experimentalApi but generate-ts omits it. Add the
 * field by intersection rather than manually rewriting parameters; future generated support makes
 * the intersection harmlessly redundant.
 */
type ExperimentalTurnStartParams = TurnStartParams & {
  collaborationMode?: CollaborationMode | null
}

/**
 * Input of the synthetic `Agent` call standing for a Codex sub-agent. Model and effort use the
 * keys of Claude's Agent tool input (`model`, `effort`), so both CLIs show them the same way; they
 * stay absent until Codex names them rather than reading as null.
 */
interface SubAgentInput {
  description: string
  prompt: string
  model?: string
  effort?: string
}

/** config.toml values Sillage applies for settings left to the CLI. */
interface CliDefaults {
  networkAccess: boolean
  serviceTier: string | null
}

const NO_CLI_DEFAULTS: CliDefaults = { networkAccess: false, serviceTier: null }

interface ChildThread {
  toolId: string
  parent: string | null
  description: string
  input: SubAgentInput
  startedAt: number
  running: boolean
}

/** What a sub-agent runs on, as far as one Codex record knows. */
interface SubAgentRunsOn {
  model?: string
  reasoningEffort?: string
}

function runsOn(source: { model?: string | null; reasoningEffort?: string | null }): SubAgentRunsOn {
  return { model: source.model ?? undefined, reasoningEffort: source.reasoningEffort ?? undefined }
}

function subAgentInput(description: string, prompt: string, { model, reasoningEffort }: SubAgentRunsOn): SubAgentInput {
  return { description, prompt, ...(model ? { model } : {}), ...(reasoningEffort ? { effort: reasoningEffort } : {}) }
}

/**
 * Deliberately ignored internal or redundant notifications already covered by item/completed. Keep
 * a named list rather than silent default branches so unknown notifications remain visible.
 */

/**
 * Translate messages and attachments for app-server; shared modules produce journal blocks. Codex
 * accepts localImage paths while Claude requires base64: protocols determine representation, not
 * Sillage preference.
 */
function buildUserInput(
  text: string,
  attachments: OutgoingAttachment[],
  mentions: OutgoingMention[],
  skills: Map<string, string>,
  referenceContext?: string | null,
): { blocks: ContentBlock[]; input: UserInput[] } {
  const { blocks, promptText } = describeOutgoingMessage(text, attachments, referenceContext, { mentions, skills: [...skills.keys()] })
  const input: UserInput[] = []

  // Place skills before text like the TUI: skills frame interpretation of the
  // instruction rather than adding detail afterward.
  for (const [name, path] of skills) {
    input.push({ type: 'skill', name, path })
  }

  if (promptText) {
    input.push({ type: 'text', text: promptText, text_elements: [] })
  }

  // Unlike Claude, app-server does not expand textual @path references:
  // mentions are separate inputs explicitly defined by the protocol.
  for (const mention of mentions) {
    input.push({ type: 'mention', name: mention.name, path: mention.path })
  }

  for (const attachment of attachments) {
    if (attachment.inlineImage) {
      input.push({ type: 'localImage', path: attachment.path })
    }
  }

  return { blocks, input }
}

/**
 * Normalize item/tool/requestUserInput questions. Codex lacks Claude multiSelect: responses are
 * arrays but nothing says questions accept multiple answers. Keep multiSelect false rather than
 * inventing support. Questions with null options expect free-text answers.
 */
function toQuestions(params: ToolRequestUserInputParams): AgentQuestion[] {
  return params.questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    multiSelect: false,
    allowOther: question.isOther || !question.options?.length,
    secret: question.isSecret,
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
      // Unlike Claude, Codex supplies no option previews.
      preview: null,
    })),
  }))
}

export class CodexRunner implements AgentRunner {
  /** Time allowed for an interrupted turn to close before it is closed for the CLI; tests shorten it. */
  static interruptGraceMs = 15_000
  readonly conversationId: string

  private client: CodexAppServerClient | null = null
  private threadId: string | null = null
  /** Servers supplied to this thread, distinguishing ours from CLI-configured ones. */
  private mcpServers: McpServer[] = []
  /** Servers that could not launch, added to CLI-reported inventory. */
  private mcpFailures: McpServerStatus[] = []
  /** Latest per-server startup report because inventory carries neither state nor errors. */
  private readonly mcpStartup = new Map<string, CodexMcpStartup>()
  /** Latest published inventory, journaling changes only. */
  private lastMcpPayload: string | null = null
  /** Published skill paths, the only way to resolve selected names on send. */
  private skillPaths = new Map<string, string>()
  /** Skill-library roots accepted by app-server. */
  private skillRoots: string[] = []
  private config: CodexConfig
  private readonly interactions: PendingInteractions
  private readonly asyncQuestions: CodexAsyncQuestions
  private readonly serverRequests = new Map<RequestId, string>()
  private readonly requestScopes = new Map<RequestId, { threadId: string | null; turnId: string | null }>()
  private readonly childThreads = new Map<string, ChildThread>()
  private readonly turnUsage = new CodexTurnUsage()
  private readonly subAgentUsage = new CodexSubAgentUsage()
  private readonly startedItems = new Set<string>()
  private readonly completedItems = new Set<string>()
  private readonly durations = new ToolDurations()
  /**
   * Streamed main-thread reply text not yet completed, per item. Since 0.162.1 instant_interrupt
   * defaults on: turn/steer interrupts replies. Probed on 0.163.0, agentMessage receives deltas but
   * never item/completed, and thread/read drops it too. Without this buffer interrupted replies
   * exist only as deltas, invisible to search, CLI handoffs, and read_conversation.
   */
  private readonly streamedAnswers = new Map<string, string>()
  /**
   * Steered message awaiting journaling. Write on CLI echo or otherwise turn/steer response:
   * notifications arriving in the same stdout chunk precede await continuation, which would
   * otherwise place user instructions after their generated reply.
   */
  private pendingSteer: { blocks: ContentBlock[] } | null = null
  /** Codex thread name reported by thread/name/updated. */
  private suggested: string | null = null
  /** Current turn required by turn/interrupt, unlike Claude SDK. */
  private turnId: string | null = null
  /** Interruption fallback forces idle if the CLI never closes the turn. */
  private interruptWatchdog: NodeJS.Timeout | null = null
  /**
   * Turn whose failure is already logged. CLI reports twice, through error then closing
   * turn/completed; show one banner.
   */
  private reportedErrorTurn: string | null = null
  private readonly completedTurns = new Set<string>()
  /** Actual CLI-selected model, needed when conversation configuration says default. */
  private threadModel: string | null = null
  /** Sign-in and plan from the last account/updated, to report only real changes. */
  private account: string | null = null
  /**
   * config.toml values as the CLI resolves them for this cwd and home, read once per process: what
   * the `CLI_DEFAULT` network access and service tier apply. A promise so the read overlaps thread
   * startup instead of delaying it; settled long before the first turn/start needs it.
   */
  private cliDefaults: Promise<CliDefaults> = Promise.resolve(NO_CLI_DEFAULTS)

  /** See AgentRunner: update this.config only after successful application. */
  get appliedConfig(): AgentConfig {
    return this.config
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as CodexConfig
    this.interactions = new PendingInteractions(ctx)
    this.asyncQuestions = new CodexAsyncQuestions(ctx)
  }

  /** CLI_DEFAULT maps to null, meaning apply CLI-configured policy, exactly the sentinel's intent. */
  private approvalPolicy(): AskForApproval | null {
    return this.config.askForApproval === CLI_DEFAULT ? null : this.config.askForApproval
  }

  /**
   * Sillage sandbox strings map to protocol object unions here using generated types. The policy
   * is explicit on every turn, so it replaces the CLI's own: see `codexNetworkAccessSchema` for
   * why network access needs the CLI's value looked up rather than left to it.
   */
  private async sandboxPolicy(): Promise<SandboxPolicy> {
    const setting = this.config.networkAccess
    switch (this.config.sandbox) {
      case 'read-only':
        return { type: 'readOnly', networkAccess: setting === 'on' }
      case 'danger-full-access':
        return { type: 'dangerFullAccess' }
      case 'workspace-write':
        return {
          type: 'workspaceWrite',
          // Reread each turn so worktrees created mid-session appear on the next.
          writableRoots: [...this.config.additionalDirectories, ...(this.ctx.workTrees?.() ?? [])],
          networkAccess: setting === CLI_DEFAULT ? (await this.cliDefaults).networkAccess : setting === 'on',
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        }
    }
  }

  /**
   * Speed tier for this turn, always explicit. Probed on codex-cli 0.172.0: `serviceTier` applies
   * to this turn and the next ones, an omitted field keeps the thread's tier, and `"default"` (or
   * null) is standard speed. Omitting it for the CLI default would leave a tier chosen earlier in
   * the session in force, so the sentinel sends config.toml's `service_tier`, else standard.
   */
  private async serviceTier(): Promise<string> {
    return this.config.serviceTier || (await this.cliDefaults).serviceTier || 'default'
  }

  /**
   * Codex's own defaults when the read fails or a key is absent: no network, standard speed.
   * Passing cwd includes project layers, as the CLI would see them for this conversation.
   */
  private async readCliDefaults(client: CodexAppServerClient): Promise<CliDefaults> {
    try {
      const { config } = await client.call<ConfigReadResponse, 'config/read'>('config/read', { cwd: this.ctx.cwd })
      return {
        networkAccess: config?.sandbox_workspace_write?.network_access === true,
        serviceTier: config?.service_tier || null,
      }
    } catch {
      return NO_CLI_DEFAULTS
    }
  }

  async start(): Promise<void> {
    try {
      await this.startThread()
    } catch (error) {
      if (error instanceof CodexRpcError && /failed to load configuration/i.test(error.message)) {
        // Configuration errors can contain secrets. Expose only the table name, never raw TOML.
        const server = /in `mcp_servers\.([a-zA-Z0-9_-]+)`/.exec(error.message)?.[1]
        if (server) {
          throw badRequest('codex_mcp_config_invalid',
            `Codex cannot load MCP server "${server}". Check its transport settings in Codex config.toml and Sillage.`, { server })
        }
        throw badRequest('codex_config_invalid', 'Codex cannot load its configuration. Check Codex config.toml.')
      }
      throw error
    }
  }

  private async startThread(): Promise<void> {
    this.client = new CodexAppServerClient({
      binary: this.ctx.binary,
      cwd: this.ctx.cwd,
      env: agentProcessEnv(this.ctx.processEnv),
      onNotification: (method, params) => {
        try { this.translate(method, params) }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          this.notice('codex_translation_failed', `Sillage cannot read Codex event ${method}: ${reason}`, 'warning', { method, reason, params })
        }
      },
      onServerRequest: (method, params, id) => this.handleServerRequest(method, params, id),
      onExit: (code) => this.onProcessExit(code),
    })

    await this.client.initialize(CLIENT_INFO)
    this.cliDefaults = this.readCliDefaults(this.client)

    // Before both thread/start and thread/resume. Probing established roots belong to
    // the process rather than thread, disappear with app-server, and must be restored
    // on every launch.
    const skillRoots = this.ctx.skillRoots(this.config)
    if (skillRoots.length > 0) await this.setSkillRoots(skillRoots)

    const resolved = this.ctx.resolveMcpServers(this.config)
    this.mcpServers = resolved.servers
    this.mcpFailures = failedStatuses(resolved.failures)
    // Pass to resume as well as start: this is required, not defensive. Thread
    // overrides are not persisted with threads. Probing showed threads created
    // with MCP servers lose them entirely when resumed without configuration,
    // without errors or traces. Do not simplify.
    const threadConfig = {
      ...toCodexThreadConfig(this.mcpServers),
      // Also enable structured questions during normal working mode.
      'features.default_mode_request_user_input': true,
      // That feature is flagged under development, so Codex warns about it on every thread start
      // (924 notices in production before this). Sillage turns it on deliberately: silence it.
      // Probed on codex-cli 0.172.0: the warning goes from 1 to 0.
      suppress_unstable_features_warning: true,
      // Project instructions arrive from SILLAGE.md through
      // developerInstructions: reading repository AGENTS.md too would duplicate them. Zero
      // disables only project files; CODEX_HOME AGENTS.md remains active
      // (probed on codex-cli 0.157.1).
      ...(this.ctx.maskedInstructionRoots().length > 0 ? { project_doc_max_bytes: 0 } : {}),
    }

    // Equivalent to Claude's appended system prompt. Probing the installed CLI
    // established instructions last throughout the thread; nullable
    // developer_instructions passed by collaboration mode on every turn does not
    // erase them. Resend on thread/resume for the same reason as MCP
    // configuration.
    const developerInstructions = [
      this.ctx.projectOverview(this.config),
      'Sillage displays structured user questions as interactive forms. When asking the user to choose or clarify, use the available request_user_input or request_user_input_async tool instead of listing choices in a plain message. Never treat a suggested option as a submitted answer.',
    ].filter(Boolean).join('\n\n')

    // The resume response's collaborationMode (0.156.0+) is the mode of the thread's last turn,
    // which may differ from the conversation's: it is deliberately not read. Probed on
    // codex-cli 0.172.0, a thread last run in Plan resumes reporting plan, yet the next turn/start
    // carrying default runs in Default (and the reverse); the restored mode only applies to a turn
    // that omits the field. Sillage always sends it (see collaborationMode()), so the composer's
    // mode is the one that runs and there is no mismatch to align or report.
    const started = this.ctx.resumeSessionId
      ? await this.client.call<ThreadResumeResponse, 'thread/resume'>('thread/resume', {
          threadId: this.ctx.resumeSessionId,
          cwd: this.ctx.cwd,
          approvalPolicy: this.approvalPolicy(),
          sandbox: this.config.sandbox,
          model: this.config.model,
          config: threadConfig,
          developerInstructions,
          // Without this the response includes full history and base64 images:
          // 48 MB observed September 27, 2026, enough to OOM the daemon on every resume.
          // Sillage already maintains its own log and reads none of that history.
          excludeTurns: true,
        })
      : await this.client.call<ThreadStartResponse, 'thread/start'>('thread/start', {
          cwd: this.ctx.cwd,
          approvalPolicy: this.approvalPolicy(),
          sandbox: this.config.sandbox,
          model: this.config.model,
          config: threadConfig,
          developerInstructions,
        })

    this.threadId = started.thread.id
    this.threadModel = started.model
    this.ctx.setAgentSessionId(started.thread.id)
    this.ctx.emit(
      {
        type: 'session.started',
        agent: 'codex',
        agentSessionId: started.thread.id,
        model: started.model,
        cwd: started.cwd,
        // App-server publishes no tool list because it depends on sandbox and MCP
        // configuration. Empty is preferable to guessed.
        tools: [],
      },
      started,
    )
    detach(this.publishMcpStatus(), 'MCP status publication')
    detach(this.publishSkills(), 'skills publication')
  }

  /**
   * Publish available skills and retain their paths server-side. Composers select names and this
   * table resolves files on send; otherwise client-supplied paths would dictate what the CLI reads.
   * Query the thread cwd to include repository skills; without cwds only machine skills are
   * returned.
   */
  private async publishSkills(): Promise<void> {
    const client = this.client
    if (!client) return

    try {
      const listed = await client.call<SkillsListResponse, 'skills/list'>('skills/list', {
        cwds: [this.ctx.cwd],
      })

      this.skillPaths = new Map()
      const skills: AgentSkillDto[] = []
      for (const entry of listed.data) {
        for (const skill of entry.skills) {
          // Disabled skills remain inventoried but invoking does nothing:
          // offering them would promise behavior the CLI cannot deliver.
          if (!skill.enabled) continue
          this.skillPaths.set(skill.name, skill.path)
          skills.push({
            name: skill.name,
            // Long descriptions begin with model-facing activation conditions
            // such as Use when; UI summaries are written for readers.
            description:
              skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
          })
        }
      }

      this.ctx.emit({ type: 'skills.updated', skills })
    } catch (err) {
      // Without inventory the composer offers nothing but conversation still works:
      // there is no reason to terminate the session.
      process.stderr.write(
        `[codex ${this.conversationId}] compétences indisponibles : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /** Retain only CLI-published skill names with their paths. */
  private resolveSkills(names: string[]): Map<string, string> {
    const resolved = new Map<string, string>()
    for (const name of names) {
      const path = this.skillPaths.get(name)
      if (path) resolved.set(name, path)
    }
    return resolved
  }

  /**
   * Publish thread MCP inventory using threadId; otherwise app-server returns only user-configured
   * servers and hides Sillage overrides, the consequence of preserving user config.toml. Each
   * startup announcement rereads the entire inventory; deduplicate identical publications so logs
   * retain only actual state/tool changes.
   */
  private async publishMcpStatus(): Promise<void> {
    const client = this.client
    const threadId = this.threadId
    if (!client || !threadId) return

    try {
      const inventory: ListMcpServerStatusResponse['data'] = []
      let cursor: string | null = null
      const cursors = new Set<string>()
      do {
        const page: ListMcpServerStatusResponse = await client.call('mcpServerStatus/list', {
          threadId, detail: 'toolsAndAuthOnly', cursor,
        })
        inventory.push(...page.data)
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('Curseur MCP répété par Codex.')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      // As with Claude, servers excluded for missing secrets were never supplied,
      // so CLI inventory cannot include them.
      const servers = [
        ...this.mcpFailures,
        ...fromCodexMcpStatus(inventory, this.mcpServers, this.mcpStartup),
      ]

      const payload = JSON.stringify(servers)
      if (payload === this.lastMcpPayload) return
      this.lastMcpPayload = payload

      this.ctx.emit({ type: 'mcp.updated', servers })
    } catch (err) {
      // Threads remain usable without inventory; only status displays lag,
      // recovering on the next startup announcement.
      process.stderr.write(
        `[codex ${this.conversationId}] inventaire MCP indisponible : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /**
   * Unexpected process death, equivalent to Claude runner consumption-loop failure: close pending
   * prompts, journal the error, and set failure state so session management releases it. The next
   * message resumes the thread.
   */
  private onProcessExit(code: number | null): void {
    // Sub-agents cut off mid-turn still consumed what they reported.
    for (const id of this.subAgentUsage.unsettled()) this.settleSubAgent(id)
    this.client = null
    const cut = this.turnId !== null
    this.turnId = null
    this.clearInterruptWatchdog()

    // Death during startup means no session existed. Pending initialize or
    // thread/start rejects, start fails, and session management cleans up and
    // returns the HTTP error. Logging here too would record session termination
    // and error state for a conversation that never started.
    if (!this.threadId) return

    if (cut) {
      // What was streamed stays readable, and what the dead turn consumed is still counted:
      // `session.ended` closes the turn but carries neither.
      this.closeCutAnswers(null)
      const usage = this.turnUsage.finish()
      if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens > 0) {
        this.ctx.emit({ type: 'usage.consumed', model: this.config.model ?? null, costUsd: 0, ...usage })
      }
    }
    this.interactions.expireAll()
    this.asyncQuestions.expireAll()
    // Update status before journaling so rejected writes cannot leave a
    // dead process's conversation running.
    this.ctx.setStatus('error')
    journalDeath(this.ctx, {
      type: 'error',
      code: 'runner_failed',
      message: `codex app-server stopped unexpectedly (code ${code ?? 'unknown'}).`,
      recoverable: true,
    })
  }

  private translate(method: string, params: unknown): void {
    if (method === 'thread/started') {
      const { thread } = params as ThreadStartedNotification
      if (thread.parentThreadId) {
        this.subAgentUsage.setModel(thread.id, thread.model)
        const parent = this.childThreads.get(thread.parentThreadId)?.toolId ?? null
        this.ensureSubAgent(thread.id, thread.agentNickname ?? thread.name ?? 'Codex', parent, thread.preview, runsOn(thread))
      }
      return
    }
    const threadId = (params as { threadId?: string } | null)?.threadId
    const child = threadId && threadId !== this.threadId ? this.childThreads.get(threadId) : undefined
    // Subagent turns must never close the main thread's turn.
    if (this.threadId && threadId && threadId !== this.threadId) {
      // Counted for every sub-agent thread, including one Sillage never saw start: its tokens
      // were consumed all the same.
      if (method === 'thread/tokenUsage/updated') {
        this.subAgentUsage.update(params as ThreadTokenUsageUpdatedNotification)
        return
      }
      if (method === 'turn/completed') this.settleSubAgent(threadId)
      if (child) this.translateChild(method, params, threadId, child.toolId)
      return
    }
    const nativeTurnId = (params as { turnId?: string } | null)?.turnId
    if (nativeTurnId && !this.turnId && method.startsWith('item/')) this.beginTurn(nativeTurnId)
    switch (method) {
      case 'item/plan/delta':
      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaNotification
        if (method === 'item/agentMessage/delta') {
          this.streamedAnswers.set(p.itemId, (this.streamedAnswers.get(p.itemId) ?? '') + p.delta)
        }
        this.ctx.emit({ type: 'message.delta', messageId: p.itemId, text: p.delta, parentToolCallId: null })
        return
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const p = params as ReasoningTextDeltaNotification
        this.ctx.emit({ type: 'thinking.delta', messageId: p.itemId, text: p.delta, parentToolCallId: null })
        return
      }

      case 'item/commandExecution/outputDelta': {
        const p = params as CommandExecutionOutputDeltaNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: p.delta })
        return
      }

      case 'item/fileChange/outputDelta': {
        const p = params as CommandExecutionOutputDeltaNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: p.delta })
        return
      }

      case 'item/mcpToolCall/progress': {
        const p = params as McpToolCallProgressNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: `${p.message}\n` }, p)
        return
      }

      case 'turn/diff/updated': {
        const p = params as TurnDiffUpdatedNotification
        this.ctx.emit({ type: 'diff.updated', files: [], patch: p.diff }, p)
        return
      }

      case 'item/fileChange/patchUpdated': {
        const p = params as FileChangePatchUpdatedNotification
        this.ctx.emit({ type: 'tool.input_updated', toolCallId: p.itemId, input: { changes: p.changes } }, p)
        return
      }

      case 'item/commandExecution/terminalInteraction': {
        const p = params as TerminalInteractionNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: `\n> ${p.stdin}\n` }, p)
        return
      }

      case 'thread/settings/updated': {
        const p = params as ThreadSettingsUpdatedNotification
        const model = p.threadSettings.model
        if (this.threadModel && model !== this.threadModel) this.notice('codex_model_changed', `Codex model: ${model}`, 'info', { model })
        this.threadModel = model
        return
      }

      case 'item/reasoning/summaryPartAdded': {
        const p = params as { itemId: string; summaryIndex: number }
        if (p.summaryIndex > 0) this.ctx.emit({ type: 'thinking.delta', messageId: p.itemId, text: '\n\n', parentToolCallId: null })
        return
      }

      case 'serverRequest/resolved': {
        const p = params as ServerRequestResolvedNotification
        const requestId = this.serverRequests.get(p.requestId)
        if (requestId) {
          this.interactions.expire(requestId)
          this.serverRequests.delete(p.requestId)
          if (this.turnId) this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
        }
        return
      }

      case 'thread/status/changed': {
        const p = params as ThreadStatusChangedNotification
        if (p.status.type === 'active') {
          this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
        } else if (p.status.type === 'systemError') {
          this.notice('codex_session_error', 'Codex reports a session error.', 'warning', p)
        }
        return
      }

      case 'warning':
      case 'guardianWarning': {
        const p = params as WarningNotification
        this.notice(method, p.message, 'warning', p)
        return
      }

      case 'configWarning': {
        const p = params as ConfigWarningNotification
        this.notice(method, p.summary, 'warning', p)
        return
      }

      case 'model/rerouted': {
        const p = params as ModelReroutedNotification
        this.notice('codex_model_rerouted', `Codex uses ${p.toModel} instead of ${p.fromModel}.`, 'warning', p)
        return
      }

      case 'model/safetyBuffering/updated': {
        const p = params as ModelSafetyBufferingUpdatedNotification
        if (p.showBufferingUi) this.notice('codex_safety_buffering', 'Codex is checking its answer before sending it.', 'info', p)
        return
      }

      case 'model/verification':
        this.notice('codex_verification', 'Codex asks for an account verification.', 'warning', params)
        return

      case 'hook/started': {
        const p = params as HookStartedNotification
        this.ctx.emit({ type: 'tool.started', toolCallId: `hook-${p.run.id}`, name: `Hook/${p.run.eventName}`,
          input: { source: p.run.sourcePath, scope: p.run.scope }, parentToolCallId: null }, p)
        return
      }

      case 'hook/completed': {
        const p = params as HookCompletedNotification
        this.ctx.emit({ type: 'tool.completed', toolCallId: `hook-${p.run.id}`,
          output: { message: p.run.statusMessage, entries: p.run.entries },
          isError: p.run.status === 'failed' || p.run.status === 'blocked', durationMs: Number(p.run.durationMs ?? 0) }, p)
        return
      }

      case 'item/autoApprovalReview/started': {
        const p = params as ItemGuardianApprovalReviewStartedNotification
        this.ctx.emit({ type: 'tool.started', toolCallId: `review-${p.reviewId}`, name: 'AutoApprovalReview',
          input: p.action, parentToolCallId: null }, p)
        return
      }

      case 'item/autoApprovalReview/completed': {
        const p = params as ItemGuardianApprovalReviewCompletedNotification
        this.ctx.emit({ type: 'tool.completed', toolCallId: `review-${p.reviewId}`, output: p.review,
          isError: p.review.status === 'denied', durationMs: p.completedAtMs - p.startedAtMs }, p)
        if (p.review.status === 'denied') {
          this.notice('codex_auto_review_denied', p.review.rationale ?? 'Automatic review denied this action.', 'warning',
            { rationale: p.review.rationale ?? null, action: p.action })
        }
        return
      }

      case 'mcpServer/startupStatus/updated': {
        const p = params as McpServerStatusUpdatedNotification
        this.mcpStartup.set(p.name, { status: p.status, error: p.error })
        detach(this.publishMcpStatus(), 'MCP status publication')
        return
      }

      // Content-free invalidation signal: notifications report skill-file changes;
      // skills/list supplies their actual contents.
      case 'skills/changed': {
        detach(this.publishSkills(), 'skills publication')
        return
      }

      case 'item/started': {
        const { item } = params as { item: ThreadItem }
        this.onItemStarted(item, params)
        return
      }

      case 'item/completed': {
        const { item } = params as { item: ThreadItem }
        this.onItemCompleted(item, params)
        return
      }

      case 'turn/started': {
        const p = params as TurnStartedNotification
        this.beginTurn(p.turn.id)
        return
      }

      /**
       * Mid-turn failures. When CLI will retry itself (broken streams, temporary overload), journal
       * nothing because the turn continues and banners would falsely claim failure. Otherwise
       * explain the thread's silence through its failure event.
       */
      case 'error': {
        const p = params as ErrorNotification
        if (p.willRetry) {
          this.notice('codex_retry', `Codex is retrying after an interruption: ${p.error.message}`, 'info', { message: p.error.message })
          return
        }
        this.reportedErrorTurn = p.turnId
        this.ctx.emit(describeTurnError(p.error), p)
        return
      }

      case 'turn/completed': {
        const p = params as TurnCompletedNotification
        if (this.completedTurns.has(p.turn.id)) return
        this.completedTurns.add(p.turn.id)
        if (this.completedTurns.size > 64) this.completedTurns.delete(this.completedTurns.values().next().value!)
        if (this.turnId && this.turnId !== p.turn.id) return
        // Failed turns carry causes. Exhausted quota previously stopped conversations
        // silently because turn.completed alone says no more
        // than a successful completion.
        if (p.turn.status === 'failed' && p.turn.error && this.reportedErrorTurn !== p.turn.id) {
          this.ctx.emit(describeTurnError(p.turn.error), p)
        }
        this.reportedErrorTurn = null
        // Once turns finish nobody awaits answers: remaining prompts died with them.
        // Leaving them open blocked approval-interrupted conversations: later Allow
        // clicks restored running state for nonexistent turns,
        // with no subsequent event capable of clearing it.
        // Close those prompts when the turn ends.
        this.expireTurnRequests(p.threadId, p.turn.id)
        if (p.turn.status !== 'completed') this.asyncQuestions.expireAll()
        this.endTurn(p.turn.status, p)
        return
      }

      case 'thread/tokenUsage/updated': {
        const p = params as ThreadTokenUsageUpdatedNotification
        this.turnUsage.update(p)
        const last = p.tokenUsage.last
        const window = p.tokenUsage.modelContextWindow

        /**
         * Context occupancy is the latest request's input size, not thread totals.
         * total.totalTokens accumulates turns (12570, 25497, 38794 across three measured turns),
         * exceeding 100 percent and never decreasing even after compaction. last.inputTokens
         * follows actual sent context including cache. Turns without user input, such as
         * compaction, report zero: retain the gauge instead of claiming empty context.
         */
        const used = last.inputTokens
        this.ctx.emit({
          type: 'usage.updated',
          costUsd: 0,
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          // Unlike Claude, app-server reports context windows spontaneously:
          // no extra request required.
          context: window && used > 0
            ? { usedTokens: used, maxTokens: window, ratio: used / window }
            : null,
          rateLimit: null,
        })
        return
      }

      case 'turn/plan/updated': {
        const p = params as TurnPlanUpdatedNotification
        this.ctx.emit({
          type: 'plan.updated',
          items: (p.plan ?? []).map((entry) => ({
            text: entry.step,
            status:
              entry.status === 'completed'
                ? 'completed'
                : entry.status === 'inProgress'
                  ? 'in_progress'
                  : 'pending',
          })),
        })
        return
      }

      case 'account/rateLimits/updated': {
        const p = params as AccountRateLimitsUpdatedNotification
        const window = p.rateLimits.primary ?? p.rateLimits.secondary
        if (!window) return
        this.ctx.emit(
          {
            type: 'usage.updated',
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            rateLimit: {
              type: describeWindow(p.rateLimits.limitName, window.windowDurationMins, true),
              // Invent no warning thresholds: only CLI-reported exceeded limits
              // change status; percentages speak for themselves.
              status: p.rateLimits.rateLimitReachedType ? 'rejected' : 'allowed',
              utilization: window.usedPercent / 100,
              resetsAt: window.resetsAt,
            },
          },
          p,
        )
        return
      }

      /**
       * Unlike Claude Code, Codex does not name threads automatically. This notification arrives
       * only after external renaming (TUI, thread/name/set), so Codex conversations retain their
       * first-message excerpt.
       */
      case 'thread/name/updated': {
        const p = params as ThreadNameUpdatedNotification
        if (p.threadName) this.suggested = p.threadName
        return
      }

      /**
       * Probed on 0.172.0: sent on every thread start once routing is known, so the first one says
       * nothing new. Later ones matter only when the plan or sign-in actually changed.
       */
      case 'account/updated': {
        const p = params as AccountUpdatedNotification
        const account = `${p.authMode}:${p.planType}`
        if (this.account !== null && account !== this.account) {
          this.notice('codex_account_changed', `Codex account changed: ${p.planType ?? p.authMode ?? 'signed out'}`, 'info', p)
        }
        this.account = account
        return
      }

      // The summary is the useful text; the generic event line used to hide it.
      case 'deprecationNotice': {
        const p = params as DeprecationNoticeNotification
        this.notice(method, p.details ? `${p.summary}\n${p.details}` : p.summary, 'warning', p)
        return
      }

      default: {
        // codex/event notifications duplicate the typed v2 stream with v1 events.
        if (method.startsWith('codex/event/') || NOTIFICATION_POLICY[method] === 'ignore') return
        // Journal every state while rendering replaces the previous marker.
        this.notice('codex_event', `Codex event: ${method}`, 'info', { method, params },
          `codex-notice:${this.turnId ?? 'session'}:${method}`)
        return
      }
    }
  }

  private notice(code: string, message: string, level: 'info' | 'warning', details?: unknown, id?: string): void {
    this.ctx.emit({ type: 'agent.notice', id, code, message, level, details }, { method: code, params: details })
  }

  /**
   * The one way a turn ends, whether Codex reports it or the interrupt fallback gives up on it:
   * replies cut mid-stream are kept as messages, usage is counted, `turn.completed` is journaled.
   */
  private endTurn(stopReason: string, raw: unknown): void {
    if (this.turnId) this.completedTurns.add(this.turnId)
    if (this.completedTurns.size > 64) this.completedTurns.delete(this.completedTurns.values().next().value!)
    this.turnId = null
    this.clearInterruptWatchdog()
    // Interrupted replies without steering close before the turn's completion event,
    // preserving their position within the same logged turn.
    this.closeCutAnswers(raw)
    // App-server reports no cost, unbilled on subscriptions anyway: inventing one is worse than omission.
    this.ctx.emit({ type: 'turn.completed', stopReason, costUsd: 0, ...this.turnUsage.finish() }, raw)
    this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'idle')
  }

  private beginTurn(id: string): void {
    if (this.turnId === id || this.completedTurns.has(id)) return
    this.turnId = id
    this.turnUsage.start(id)
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'running')
  }

  private settleSubAgent(threadId: string): void {
    const usage = this.subAgentUsage.settle(threadId)
    if (usage) this.ctx.emit({ type: 'usage.consumed', costUsd: 0, ...usage })
  }

  private ensureSubAgent(threadId: string, label: string, parent: string | null, prompt = '', known: SubAgentRunsOn = {}): string {
    const previous = this.childThreads.get(threadId)
    if (previous?.running) {
      this.describeSubAgent(previous, known)
      return previous.toolId
    }
    // consumption/codex-subagent-history.ts reads the thread back from this id: keep its shape.
    const toolId = `codex-agent-${threadId}-${randomUUID()}`
    // A restarted agent keeps the model it was created with: later activities carry none.
    const input = subAgentInput(label, prompt || label, { model: known.model ?? previous?.input.model,
      reasoningEffort: known.reasoningEffort ?? previous?.input.effort })
    this.childThreads.set(threadId, { toolId, parent, description: label, input, startedAt: Date.now(), running: true })
    this.ctx.emit({ type: 'tool.started', toolCallId: toolId, name: 'Agent', input, parentToolCallId: parent })
    this.ctx.emit({ type: 'task.started', taskId: threadId, toolCallId: toolId, kind: 'agent', description: label, workflowName: null })
    this.publishSubAgents()
    return toolId
  }

  /**
   * Model and effort learned after the call started (a spawning call seen after the agent's first
   * event) reach the row through its input, the journal's only per-call record.
   */
  private describeSubAgent(agent: ChildThread, known: SubAgentRunsOn): void {
    const model = known.model ?? agent.input.model
    const reasoningEffort = known.reasoningEffort ?? agent.input.effort
    if (model === agent.input.model && reasoningEffort === agent.input.effort) return
    agent.input = subAgentInput(agent.input.description, agent.input.prompt, { model, reasoningEffort })
    this.ctx.emit({ type: 'tool.input_updated', toolCallId: agent.toolId, input: agent.input })
  }

  private completeSubAgent(threadId: string, output: unknown, isError = false): void {
    const agent = this.childThreads.get(threadId)
    if (!agent?.running) return
    agent.running = false
    this.publishSubAgents()
    this.ctx.emit({ type: 'tool.completed', toolCallId: agent.toolId, output, isError,
      durationMs: Date.now() - agent.startedAt })
    this.ctx.emit({ type: 'task.completed', taskId: threadId, status: isError ? 'failed' : 'completed',
      summary: typeof output === 'string' ? output : JSON.stringify(output), durationMs: Date.now() - agent.startedAt, ambient: false })
  }

  private publishSubAgents(): void {
    this.ctx.emit({ type: 'background.updated', tasks: [...this.childThreads]
      .filter(([, agent]) => agent.running)
      .map(([id, agent]) => ({ id, kind: 'agent', description: agent.description })) })
  }

  private subAgentActivity(item: Extract<ThreadItem, { type: 'subAgentActivity' }>, parent: string | null): void {
    // interacted means message delivery rather than activity: Codex TUI ignores it
    // for the same reason. If delivery restarts the agent, its thread's turn/started
    // re-adds it. Counting delivery as startup left finished subagents running
    // forever after messages, or marked the main thread active when subagents
    // wrote to /root, with no later event closing them.
    if (item.kind === 'interacted' || item.agentThreadId === this.threadId) return
    this.subAgentUsage.setModel(item.agentThreadId, item.model)
    if (item.kind === 'started') {
      // Probed on 0.172.0: `started` carries the resolved model and effort (the parent's when the
      // spawn named none), `completed` carries null for both.
      this.ensureSubAgent(item.agentThreadId, item.agentPath, parent, '', runsOn(item))
    } else {
      this.completeSubAgent(item.agentThreadId, { agent: item.agentPath, status: item.kind })
    }
  }

  private translateChild(method: string, params: unknown, threadId: string, parent: string): void {
    switch (method) {
      case 'turn/started': {
        const child = this.childThreads.get(threadId)!
        this.ensureSubAgent(threadId, child.description, child.parent)
        return
      }
      case 'item/started': {
        const { item } = params as { item: ThreadItem }
        this.onItemStarted(item, params, parent)
        return
      }
      case 'item/completed': {
        const { item } = params as { item: ThreadItem }
        this.onItemCompleted(item, params, parent)
        return
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const p = params as AgentMessageDeltaNotification
        this.ctx.emit({ type: method.includes('/reasoning/') ? 'thinking.delta' : 'message.delta',
          messageId: p.itemId, text: p.delta, parentToolCallId: parent })
        return
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const p = params as CommandExecutionOutputDeltaNotification
        this.ctx.emit({ type: 'tool.output_delta', toolCallId: p.itemId, chunk: p.delta })
        return
      }
      case 'turn/completed': {
        const p = params as TurnCompletedNotification
        this.expireTurnRequests(threadId, p.turn.id)
        this.completeSubAgent(threadId, p.turn.items.filter((item) => item.type === 'agentMessage')
          .map((item) => item.text).join('\n\n') || p.turn.error?.message || p.turn.status, p.turn.status === 'failed')
        if (!this.turnId) this.ctx.setStatus(this.interactions.hasBlocking ? 'awaiting_input' : 'idle')
        return
      }
      case 'serverRequest/resolved': {
        const p = params as ServerRequestResolvedNotification
        const requestId = this.serverRequests.get(p.requestId)
        if (requestId) this.interactions.expire(requestId)
        return
      }
      default:
        if (method === 'error' || method === 'warning') this.childProblem(method, params, threadId)
    }
  }

  /**
   * A sub-agent's warning or error, with its own text: the generic line used instead hid usage
   * limits behind "a sub-agent reports a problem". Same split as the main thread: a retry is
   * information, anything else a warning. Not an `error` event, which would fail the parent turn.
   */
  private childProblem(method: 'error' | 'warning', params: unknown, threadId: string): void {
    const agent = this.childThreads.get(threadId)?.description || 'Codex'
    if (method === 'warning') {
      const { message } = params as WarningNotification
      this.notice('codex_subagent_warning', `${agent}: ${message}`, 'warning', { agent, message })
      return
    }
    const p = params as ErrorNotification
    const message = p.error.additionalDetails ? `${p.error.message}\n${p.error.additionalDetails}` : p.error.message
    if (p.willRetry) {
      this.notice('codex_retry', `${agent} is retrying after an interruption: ${message}`, 'info', { agent, message })
    } else {
      this.notice('codex_subagent_error', `${agent}: ${message}`, 'warning',
        { agent, message, code: codexErrorCode(p.error.codexErrorInfo) })
    }
  }

  private onItemStarted(item: ThreadItem, raw: unknown, parent: string | null = null): void {
    if (this.startedItems.has(item.id) || this.completedItems.has(item.id)) return
    // Steered-message echoes signal the current reply was interrupted:
    // no other event says so and no further reply output arrives.
    // Journal steered messages before closing replies, matching ordering when
    // steer acknowledgments arrive alone before notifications.
    if (item.type === 'userMessage' && parent === null) {
      this.flushPendingSteer()
      this.closeCutAnswers(raw)
    }
    this.startedItems.add(item.id)
    this.durations.start(item.id)
    for (const event of startedItem(item, parent)) this.ctx.emit(event, raw)
  }

  /**
   * Close abandoned replies with already displayed text and mark IDs completed. Otherwise late
   * item/completed events would append blocks again because the client fold concatenates matching
   * IDs.
   */
  private closeCutAnswers(raw: unknown): void {
    for (const [itemId, text] of this.streamedAnswers) {
      this.completedItems.add(itemId)
      this.startedItems.delete(itemId)
      this.durations.stop(itemId)
      if (text) {
        this.ctx.emit({ type: 'message.completed', messageId: itemId, role: 'assistant', blocks: [{ type: 'text', text }], parentToolCallId: null }, raw)
      }
    }
    this.streamedAnswers.clear()
  }

  private onItemCompleted(item: ThreadItem, raw: unknown, parent: string | null = null): void {
    if (this.completedItems.has(item.id)) return
    this.streamedAnswers.delete(item.id)
    if (!this.startedItems.has(item.id)) this.onItemStarted(item, raw, parent)
    this.completedItems.add(item.id)
    this.startedItems.delete(item.id)
    if (this.completedItems.size > 4096) this.completedItems.delete(this.completedItems.values().next().value!)
    for (const event of completedItem(item, this.ctx.cwd, this.durations.stop(item.id), parent)) {
      // The native completion already retains the full payload, including large images/output.
      this.ctx.emit(event, event.type === 'tool.input_updated' ? undefined : raw)
    }
    if (item.type === 'agentMessage') this.asyncQuestions.request(item, raw)
    if (item.type === 'subAgentActivity') this.subAgentActivity(item, parent)
    if (item.type === 'collabAgentToolCall') {
      for (const threadId of item.receiverThreadIds) {
        if (threadId === this.threadId) continue
        // Probed on 0.169.0: the child's thread/started carries no model, the spawning call does.
        if (item.tool === 'spawnAgent') this.subAgentUsage.setModel(threadId, item.model)
        const state = item.agentsStates[threadId]
        if (['spawnAgent', 'resumeAgent', 'sendInput', 'followupTask'].includes(item.tool) && item.status !== 'failed') {
          this.ensureSubAgent(threadId, threadId, parent, item.prompt ?? '', item.tool === 'spawnAgent' ? runsOn(item) : {})
        }
        if (state && ['completed', 'errored', 'shutdown', 'interrupted', 'notFound'].includes(state.status)) {
          this.completeSubAgent(threadId, state.message ?? state.status, state.status === 'errored' || state.status === 'notFound')
        }
      }
    }
  }

  /**
   * All three Codex approval requests map to the same event as Claude canUseTool, sharing one
   * permission UI.
   */
  private async handleServerRequest(method: string, params: unknown, rpcId: RequestId): Promise<unknown> {
    const scope = params as { threadId?: string; turnId?: string } | null
    this.requestScopes.set(rpcId, { threadId: scope?.threadId ?? this.threadId, turnId: scope?.turnId ?? null })
    try { return await this.dispatchServerRequest(method, params, rpcId) }
    finally { this.requestScopes.delete(rpcId) }
  }

  private expireTurnRequests(threadId: string, turnId: string): void {
    for (const [rpcId, requestId] of this.serverRequests) {
      const scope = this.requestScopes.get(rpcId)
      if (scope?.threadId === threadId && (scope.turnId === null || scope.turnId === turnId)) {
        this.interactions.expire(requestId)
      }
    }
  }

  private dispatchServerRequest(method: string, params: unknown, rpcId: RequestId): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const p = params as CommandExecutionRequestApprovalParams
        return this.askPermission(
          rpcId, 'Bash',
          { command: p.command, cwd: p.cwd, reason: p.reason, kind: p.kind, network: p.networkApprovalContext },
          (allowed, scope): CommandExecutionRequestApprovalResponse => ({
            decision: allowed ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
          }),
        )
      }

      case 'item/fileChange/requestApproval': {
        const p = params as FileChangeRequestApprovalParams
        return this.askPermission(
          rpcId, 'Edit',
          { reason: p.reason, grantRoot: p.grantRoot },
          (allowed, scope): FileChangeRequestApprovalResponse => ({
            decision: allowed ? (scope === 'session' ? 'acceptForSession' : 'accept') : 'decline',
          }),
        )
      }

      case 'item/permissions/requestApproval': {
        const p = params as PermissionsRequestApprovalParams
        return this.askPermission(
          rpcId, 'Permissions',
          { reason: p.reason, cwd: p.cwd, permissions: p.permissions },
          (allowed, scope): PermissionsRequestApprovalResponse => ({
            // Denying grants no permissions: the protocol has no denial variant,
            // only the actually granted profile.
            //
            // Granting copies the requested profile except unrequested sections:
            // null sections must become absent in granted profiles.
            permissions: allowed
              ? {
                  network: p.permissions.network ?? undefined,
                  fileSystem: p.permissions.fileSystem ?? undefined,
                }
              : {},
            scope: scope === 'session' ? 'session' : 'turn',
          }),
        )
      }

      case 'item/tool/requestUserInput': {
        const p = params as ToolRequestUserInputParams
        return this.askQuestion(p, rpcId)
      }

      case 'mcpServer/elicitation/request': {
        const p = params as McpServerElicitationRequestParams
        return this.askElicitation(p, rpcId)
      }

      default:
        this.notice('codex_unsupported_request', `Codex asks for an interaction Sillage does not support: ${method}.`, 'warning', { method, params })
        return Promise.reject(new CodexRpcError(`Unhandled server request: ${method}`, -32601))
    }
  }

  private askQuestion(params: ToolRequestUserInputParams, rpcId: RequestId): Promise<ToolRequestUserInputResponse> {
    return new Promise<ToolRequestUserInputResponse>((resolve) => {
      const requestId = this.interactions.requestQuestion(toQuestions(params), (answer) => {
        this.serverRequests.delete(rpcId)
        // Cancellation/expiry returns empty answers because the protocol has no
        // no-answer variant and leaving RPC requests unanswered
        // would freeze turns.
        const answers = answer === null || answer.status === 'cancelled' ? {} : answer.answers
        resolve({
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
          ),
        })
      }, params.isBlocking !== false)
      this.serverRequests.set(rpcId, requestId)
    })
  }

  async answerQuestion(requestId: string, answer: QuestionAnswer): Promise<boolean> {
    if (this.interactions.resolveQuestion(requestId, answer)) return true
    return this.asyncQuestions.answer(requestId, answer, async (text, clientMessageId, threadId) => {
      if (!this.client || !this.threadId) throw new Error('The Codex session is closed.')
      const input: UserInput[] = [{ type: 'text', text, text_elements: [] }]
      const child = threadId && threadId !== this.threadId ? this.childThreads.get(threadId) : null
      if (child && threadId) await this.client.call('turn/start', { threadId, input, clientUserMessageId: clientMessageId })
      else await this.startTurn(input, clientMessageId)
      this.ctx.emit({ type: 'message.completed', messageId: clientMessageId, role: 'user',
        blocks: [{ type: 'text', text }], parentToolCallId: child?.toolId ?? null })
    })
  }

  /**
   * MCP elicitation. Previously default rejection made input-requesting MCP servers fail entire
   * turns. This was the only missing interaction channel causing failures rather than merely lost
   * functionality.
   */
  private askElicitation(
    params: McpServerElicitationRequestParams,
    rpcId: RequestId,
  ): Promise<McpServerElicitationRequestResponse> {
    return new Promise<McpServerElicitationRequestResponse>((resolve) => {
      const requestId = this.interactions.requestElicitation(
        {
          serverName: params.serverName,
          // openai/form schemas are untyped by the protocol: use the same parser,
          // tolerant of shapes it does not
          // recognize.
          mode: params.mode === 'url' ? 'url' : 'form',
          message: params.message,
          url: params.mode === 'url' ? params.url : null,
          fields: params.mode === 'url' ? [] : parseElicitationFields(params.requestedSchema),
          title: null,
        },
        (answer) => {
          this.serverRequests.delete(rpcId)
          if (answer === null) {
            // Use cancel rather than decline: MCP distinguishes explicit refusal
            // from requests never delivered to anyone.
            resolve({ action: 'cancel', content: null, _meta: null })
            return
          }
          resolve({
            action: answer.action,
            content: answer.action === 'accept' ? answer.content : null,
            _meta: null,
          })
        },
      )
      this.serverRequests.set(rpcId, requestId)
    })
  }

  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    return this.interactions.resolveElicitation(requestId, answer)
  }

  /**
   * Codex does not submit plans for approval: Plan mode produces thread items rather than blocking
   * requests. Returning false explicitly conveys that no decision was made.
   */
  reviewPlan(_requestId: string, _review: PlanReview): boolean {
    return false
  }

  private askPermission<T>(
    rpcId: RequestId,
    toolName: string,
    input: unknown,
    buildResponse: (allowed: boolean, scope: PermissionDecision['scope']) => T,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const requestId = this.interactions.requestPermission({ toolName, input }, (decision) => {
        this.serverRequests.delete(rpcId)
        // Expiry means one-time refusal: send the same response as no because
        // the CLI has no unanswered variant.
        const allowed = decision !== null && decision.decision === 'allowed'
        resolve(buildResponse(allowed, decision?.scope ?? 'once'))
      })
      this.serverRequests.set(rpcId, requestId)
    })
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.interactions.resolvePermission(requestId, decision)
  }

  async send(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
    skills: string[],
  ): Promise<void> {
    if (!this.client || !this.threadId) throw new Error('The Codex session has not started.')

    // The manager journaled the message before starting this runner; only steering echoes here.
    const { input } = buildUserInput(text, attachments, mentions, this.resolveSkills(skills), this.ctx.sessionReferenceContext?.(text, this.appliedConfig))
    this.ctx.setStatus('running')

    try {
      await this.startTurn(input)
    } catch (error) {
      if (!this.turnId && this.client) this.ctx.setStatus('idle')
      throw error
    }
  }

  private async startTurn(input: UserInput[], clientUserMessageId?: string): Promise<void> {
    if (!this.client || !this.threadId) throw new Error('The Codex session is closed.')
    // Configuration travels per turn as defined by the protocol,
    // making setting changes immediate.
    const turn = await this.client.callExperimental<TurnStartResponse>('turn/start', {
      threadId: this.threadId,
      clientUserMessageId,
      input,
      cwd: this.ctx.cwd,
      approvalPolicy: this.approvalPolicy(),
      sandboxPolicy: await this.sandboxPolicy(),
      model: this.config.model,
      serviceTier: await this.serviceTier(),
      effort: this.config.reasoningEffort || null,
      // app-server sends no reasoning summary unless asked (probed on 0.163.0: empty
      // `summary` without this field), unlike `codex exec`, so the thread showed no thinking.
      summary: 'auto',
      collaborationMode: this.collaborationMode(),
    } satisfies ExperimentalTurnStartParams)
    // Notifications can precede RPC responses, including completion.
    if (turn.turn.status === 'inProgress' && !this.completedTurns.has(turn.turn.id)) {
      // Some versions respond without turn/started notifications.
      this.beginTurn(turn.turn.id)
    }
  }

  /**
   * Turn collaboration mode, null until the actual model is known. Protocol settings.model is
   * required while conversation model may be CLI_DEFAULT; use thread/start's reported model.
   * Without it omit mode rather than invent model IDs. Never omit it to mean "default": on a resumed
   * thread an omitted mode falls back to the one the CLI restored from the last turn.
   */
  private collaborationMode(): CollaborationMode | null {
    const model = this.config.model || this.threadModel
    if (!model) return null

    return {
      mode: this.config.collaborationMode,
      settings: {
        model,
        // Retain conversation effort rather than CLI preset effort, which would
        // silently overwrite the user's choice.
        reasoning_effort: this.config.reasoningEffort || null,
        developer_instructions: null,
      },
    }
  }

  /**
   * Steer the active turn. expectedTurnId is a protocol precondition rejecting turns changed
   * between display and click, the desired behavior. Installed-CLI probing confirmed stable turn
   * IDs: steering redirects within the existing turn. Journal messages here like send; app-server
   * echoes userMessage items ignored by translation to avoid duplicate writes.
   */
  async steer(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
    skills: string[],
  ): Promise<boolean> {
    if (!this.client || !this.threadId || !this.turnId) return false

    const { blocks, input } = buildUserInput(text, attachments, mentions, this.resolveSkills(skills), this.ctx.sessionReferenceContext?.(text, this.appliedConfig))
    this.pendingSteer = { blocks }
    try {
      await this.client.call('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        input,
      })
    } catch (error) {
      // Rejected after turn completion: nothing sent, nothing journaled.
      this.pendingSteer = null
      throw error
    }
    this.flushPendingSteer()
    return true
  }

  private flushPendingSteer(): void {
    if (!this.pendingSteer) return
    const { blocks } = this.pendingSteer
    this.pendingSteer = null
    this.ctx.emit({
      type: 'message.completed',
      messageId: randomUUID(),
      role: 'user',
      blocks,
      parentToolCallId: null,
    })
  }

  /** Compaction uses a dedicated app-server request unlike Claude, without conversation messages. */
  async compact(): Promise<boolean> {
    if (!this.client || !this.threadId) return false
    await this.client.call('thread/compact/start', { threadId: this.threadId })
    // Notifications cannot distinguish compaction from ordinary turns:
    // only this initiating request knows what it started.
    this.ctx.emit({ type: 'context.compaction_started' })
    return true
  }

  /** This adapter exposes no targeted stop from task lists. */
  async stopBackgroundTask(): Promise<boolean> {
    return false
  }

  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'codex') return false
    // Account home is app-server environment read at startup: account changes
    // restart the process and resume threads from the new home, sharing
    // session directories.
    if (config.account !== this.config.account) return false
    // MCP servers are thread overrides read at thread/start and thread/resume only: app-server has
    // no call to replace them (`config/mcpServer/reload` takes no server list).
    // Accepting the change here left newly enabled servers missing until a new conversation
    // (probed on codex-cli 0.163.0); restarting resumes the thread with the new list.
    if (JSON.stringify(this.ctx.resolveMcpServers(config).servers) !== JSON.stringify(this.mcpServers)) {
      return false
    }
    // Unlike Claude plugins, roots change live. Empty lists remove the library
    // and skills/changed updates inventory.
    const skillRoots = this.ctx.skillRoots(config)
    if (this.client && JSON.stringify(skillRoots) !== JSON.stringify(this.skillRoots)) {
      await this.setSkillRoots(skillRoots)
    }
    this.config = config
    return true
  }

  /**
   * Reapply roots to reread everything. Probing showed app-server detects directory arrivals but
   * not removal; renaming, disabling, or deleting otherwise leaves old names inventoried. Existing
   * publishSkills relays subsequent skills/changed.
   */
  async reloadSkillLibrary(): Promise<void> {
    if (this.skillRoots.length > 0) await this.setSkillRoots(this.skillRoots)
  }

  /** No per-server call: `config/mcpServer/reload` rereads config files, not the thread overrides Sillage passes. */
  async reconnectMcpServer(): Promise<boolean> {
    return false
  }

  /**
   * Replace library roots with each plugin's skills directory, the skill-directory shape app-server
   * expects. Failure leaves sessions usable without libraries so older CLIs lacking this method
   * remain functional.
   */
  private async setSkillRoots(roots: string[]): Promise<void> {
    if (!this.client) return
    try {
      await this.client.call<SkillsExtraRootsSetResponse, 'skills/extraRoots/set'>('skills/extraRoots/set', {
        extraRoots: roots.map((root) => join(root, 'skills')),
      })
      this.skillRoots = roots
    } catch (err) {
      process.stderr.write(
        `[codex ${this.conversationId}] bibliothèque de skills indisponible : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  async suggestedTitle(): Promise<string | null> {
    return this.suggested
  }

  async interrupt(): Promise<void> {
    this.asyncQuestions.expireAll()
    // Without active turns there is nothing to interrupt: the protocol requires turnId.
    // Still provide an escape: returning silently when conversation state is busy
    // without an open turn would leave it busy permanently.
    if (!this.client || !this.threadId || !this.turnId) {
      this.interactions.expireAll()
      this.ctx.setStatus('idle')
      return
    }
    const interrupted = this.turnId
    const client = this.client

    // Do not set idle on the reply: app-server sends authoritative turn/completed.
    // Announcing earlier would flush queued messages while interrupted turns
    // still finish. The fallback covers completions that never arrive,
    // such as unanswered approval requests; otherwise conversations
    // would stay busy until idle timeout and subsequent messages
    // would queue needlessly. Armed before asking: the request itself can
    // go unanswered, and nothing else would close the turn.
    this.clearInterruptWatchdog()
    this.interruptWatchdog = setTimeout(() => {
      this.interruptWatchdog = null
      if (this.turnId !== interrupted) return
      this.interactions.expireAll()
      this.endTurn('interrupted', null)
    }, CodexRunner.interruptGraceMs)
    this.interruptWatchdog.unref()

    try {
      await client.call('turn/interrupt', { threadId: this.threadId, turnId: interrupted })
    } catch (err) {
      // An RPC error is an answer (the turn had already ended, for one): the watchdog stays in charge.
      if (err instanceof CodexRpcError || this.client !== client) return
      // No answer within the request timeout: the app-server is wedged and would hang the next
      // turn/start the same way. Close the turn, then retire the process like a crash, so the
      // next message starts a fresh one on the same thread.
      if (this.turnId === interrupted) {
        this.interactions.expireAll()
        this.endTurn('interrupted', null)
      }
      client.close()
      this.onProcessExit(null)
    }
  }

  private clearInterruptWatchdog(): void {
    if (this.interruptWatchdog) clearTimeout(this.interruptWatchdog)
    this.interruptWatchdog = null
  }

  async stop(): Promise<void> {
    for (const id of this.subAgentUsage.unsettled()) this.settleSubAgent(id)
    this.asyncQuestions.expireAll()
    this.clearInterruptWatchdog()
    this.interactions.expireAll()
    this.client?.close()
    this.client = null
  }
}
