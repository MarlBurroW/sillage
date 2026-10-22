import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  getSessionInfo,
  query,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type FastModeDisabledReason,
  type FastModeState,
  type HookCallback,
  type McpServerConfig,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import {
  claudePermissionModeSchema,
  parseElicitationFields,
  type AgentConfig,
  type ClaudeConfig,
  type ContentBlock,
  type McpServerStatus,
  type PlanFollowUpOption,
} from '@sillage/protocol'
import { failedStatuses } from '../mcp-registry.js'
import { sdkExecutable } from '../launch.js'
import { AsyncQueue } from '../async-queue.js'
import { agentProcessEnv } from '../process-env.js'
import { PendingInteractions } from '../interactions.js'
import { describeOutgoingMessage } from '../outgoing.js'
import { journalDeath } from '../session-close.js'
import { toWorkspacePath } from '../paths.js'
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
import { toDto as toCommandDtos } from './command-catalog.js'
import { editedPath, fileExists } from './file-edits.js'
import { fromSdkMcpStatus, toSdkMcpServers } from './mcp.js'
import { skillLibraryLaunchOptions } from './skill-library.js'
import { claudeMdExcludes } from '../../instructions/store.js'
import { flagSettings, liveFlagSettings } from './flag-settings.js'
import { toPermissionMode } from './permission-mode.js'
import {
  ASK_USER_QUESTION,
  EXIT_PLAN_MODE,
  toPlan,
  toQuestions,
  toUpdatedInput,
} from './prompts.js'
import { describeFastMode, describePluginErrors, translateSignal } from './signals.js'

/**
 * Native messages intentionally ignored: internal progress (session state changes) adds nothing to
 * thread. Named list instead of silent `default:` keeps unknown new types visible. Others pass
 * through `translateSignal`.
 */
const IGNORED_SUBTYPES = new Set(['session_state_changed'])

/**
 * Thinking-counter step, in estimated tokens.
 *
 * CLI publishes once per received chunk, several times per second. Journaling each would grow
 * history for visually indistinguishable values. This step keeps sustained thinking animated
 * several times per second while writing only a handful of rows for short thinking.
 */
const THINKING_TOKENS_STEP = 100

/** Time allowed for CLI to close turns suspected of producing no `result`. See `armTurnWatchdog`. */
const TURN_CLOSE_GRACE_MS = 15_000

/**
 * Plan-approval continuations. IDs are Claude permission modes proposed/revalidated by this
 * adapter; common schema treats them as opaque strings.
 */
const PLAN_FOLLOW_UP_OPTIONS: PlanFollowUpOption[] = [
  {
    id: 'acceptEdits',
    label: 'Valider et laisser écrire',
    hint: 'Les modifications de fichiers passent sans demande',
  },
  {
    id: 'manual',
    label: 'Valider et demander',
    hint: 'Chaque outil reste soumis à ton accord',
  },
]

/**
 * Accepted user-message blocks derived from SDK types, not copied: API image formats change, and
 * manual copies would drift silently.
 */
type PromptBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type InlineImageSource = Extract<
  Extract<PromptBlock, { type: 'image' }>['source'],
  { type: 'base64' }
>

/**
 * Translate message/attachments to SDK protocol. Journaled blocks come from shared module; images
 * use base64, other files paths, the only way agents can open them with tools.
 */
async function buildUserMessage(
  text: string,
  attachments: OutgoingAttachment[],
): Promise<{ blocks: ContentBlock[]; prompt: PromptBlock[] }> {
  const { blocks, promptText } = describeOutgoingMessage(text, attachments)
  const prompt: PromptBlock[] = []

  if (promptText) {
    prompt.push({ type: 'text', text: promptText })
  }

  for (const attachment of attachments) {
    if (!attachment.inlineImage) continue
    const data = await readFile(attachment.path)
    prompt.push({
      type: 'image',
      source: {
        type: 'base64',
        // Type already restricted to API-supported formats when deciding `inlineImage`, making this
        // cast safe.
        media_type: attachment.mimeType as InlineImageSource['media_type'],
        data: data.toString('base64'),
      },
    })
  }

  return { blocks, prompt }
}

export class ClaudeRunner implements AgentRunner {
  readonly conversationId: string

  private readonly input = new AsyncQueue<SDKUserMessage>()
  private readonly interactions: PendingInteractions
  private readonly durations = new ToolDurations()
  /**
   * Pending writes per call: target path and pre-call existence. Tool results contain neither, so
   * retain them.
   */
  private readonly pendingEdits = new Map<string, { path: string; existed: boolean }>()
  private readonly abort = new AbortController()
  private session: Query | null = null
  /** Incoming message per author: main agent (null) and each subagent. */
  private readonly streamingMessageIds = new Map<string | null, string>()
  /** Last forwarded thinking count, limiting events to one per `THINKING_TOKENS_STEP`. */
  private thinkingTokensSent = 0
  /** Native ID required to read session summary. */
  private sessionId: string | null = null
  /** Session/model from last journaled `session.started`, preventing per-turn repetition. */
  private initSignature: string | null = null
  /** Last init `plugin_errors`, reported only on change. */
  private pluginErrorsSignature = '[]'
  /** Latest CLI Fast state, journaling changes only. */
  private fastMode: { state: FastModeState; reason: FastModeDisabledReason | null } | null = null
  private stopped = false
  /** True from turn opening until closing `result`. */
  private turnOpen = false
  /** Forced-closure deadline armed when no `result` is expected. */
  private turnWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Tracks live changes unlike frozen `ctx.config`. */
  private config: ClaudeConfig
  /**
   * Session launched in `bypassPermissions` with prompts disabled. Kept separately because first
   * live change removes it from `this.config`; launch state, not current setting, determines
   * behavior.
   */
  private readonly launchedWithBypass: boolean
  /**
   * What session actually received, so `setMcpServers` runs only on real change. SDK restarts every
   * server per call, making redundant calls disconnect healthy connections.
   */
  private appliedMcpServers: Record<string, McpServerConfig> = {}
  /** Servers that failed to launch, added to CLI-reported inventory. */
  private mcpFailures: McpServerStatus[] = []
  /**
   * Skill-library roots received at launch. Plugins are launch-only options: changed lists require
   * restart; see `applyConfig`.
   */
  private skillRoots: string[] = []

  /** See `AgentRunner`. `this.config` advances only after successful application. */
  get appliedConfig(): AgentConfig {
    return this.config
  }

  constructor(private readonly ctx: RunnerContext) {
    this.conversationId = ctx.conversationId
    this.config = ctx.config as ClaudeConfig
    this.launchedWithBypass = this.config.permissionMode === 'bypassPermissions'
    this.interactions = new PendingInteractions(ctx)
  }

  async start(): Promise<void> {
    const config = this.config
    const resolved = this.ctx.resolveMcpServers(config)
    this.appliedMcpServers = toSdkMcpServers(resolved.servers)
    this.mcpFailures = failedStatuses(resolved.failures)

    // Use system prompt, not initially tried `SessionStart` hook: hooks register in initialization
    // request while SessionStart is first event. Callback had no effect, verified on new session
    // receiving nothing. `preset` retains Claude default prompt and adds only this appendix.
    const overview = this.ctx.projectOverview(config)
    this.skillRoots = this.ctx.skillRoots(config)
    const library = skillLibraryLaunchOptions(this.skillRoots)

    this.session = query({
      prompt: this.input,
      options: {
        ...(overview
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: overview } }
          : {}),
        cwd: this.ctx.cwd,
        env: agentProcessEnv(this.ctx.processEnv),
        model: config.model,
        effort: config.effort,
        permissionMode: toPermissionMode(config.permissionMode),
        // SDK requires this opt-in besides mode; do not depend on installed binary tolerance that
        // may change after updates.
        allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions',
        // Attachments live outside workspace: without this allowed directory agents cannot read
        // attached files. Same for library skill supporting files. Session-created worktrees
        // outside cwd are read at launch; later trees count only after CLI restart.
        additionalDirectories: [
          ...config.additionalDirectories,
          this.ctx.attachmentsRoot,
          ...library.additionalDirectories,
          ...(this.ctx.workTrees?.() ?? []),
        ],
        plugins: library.plugins,
        // Passed in memory at every launch, never written to `~/.claude.json`: native-CLI resume
        // therefore lacks these servers, the cost of leaving user files untouched. Established by
        // probe, not inferable from documentation.
        mcpServers: this.appliedMcpServers,
        strictMcpConfig: config.strictMcp,
        settings: flagSettings(
          config,
          library.deny,
          claudeMdExcludes(this.ctx.maskedInstructionRoots()),
          this.ctx.memoryDir(),
        ),
        // Caps for unattended sessions. Launch-only options: changes restart runner; see
        // `applyConfig`.
        ...(config.maxBudgetUsd === null ? {} : { maxBudgetUsd: config.maxBudgetUsd }),
        ...(config.maxTurns === null ? {} : { maxTurns: config.maxTurns }),
        // One next-message suggestion per turn after `result`, nearly free through conversation
        // cache. Without option CLI emits none in SDK mode; with it, machine
        // `promptSuggestionEnabled: false` still disables them.
        promptSuggestions: true,
        includePartialMessages: true,
        // Otherwise SDK forwards only subagent tools, enough for counters but not threads: no
        // reasoning or intermediate messages. Sillage displays full conversations and needs
        // everything.
        forwardSubagentText: true,
        abortController: this.abort,
        ...(this.ctx.resumeSessionId ? { resume: this.ctx.resumeSessionId } : {}),
        // Always supplied, never left to SDK. Internal resolution searches platform package
        // `@anthropic-ai/claude-agent-sdk-<os>-<arch>`, no longer shipped: omission causes “Native
        // CLI binary not found” instead of using system CLI.
        pathToClaudeCodeExecutable: sdkExecutable(this.ctx.binary),
        canUseTool: this.handleToolRequest,
        onElicitation: this.handleElicitation,
        // Only channel delivering session scheduled tasks. Neither stream nor control channel
        // carries state: `CronList` is model-only, no loop message parallels
        // `background_tasks_changed`.
        hooks: { Stop: [{ hooks: [this.handleStop] }] },
        stderr: (data) => {
          // CLI stderr is not conversation content, but losing it makes diagnosis impossible.
          process.stderr.write(`[claude ${this.conversationId}] ${data}`)
        },
      },
    })

    // Background state belongs to process: CLI emits changes, nothing at startup. Sillage sets zero
    // so journal replay cannot retain dead previous-process jobs.
    this.ctx.emit({ type: 'background.updated', tasks: [] })
    // Same for loops, which die with process. Hook restores them after first turn if CLI restored
    // any on resume.
    this.ctx.emit({ type: 'loops.updated', loops: [] })
    void this.publishMcpStatus()

    // Consumed in background: runner outlives creating HTTP request.
    void this.consume()
  }

  private async consume(): Promise<void> {
    if (!this.session) return

    try {
      for await (const message of this.session) {
        this.translate(message)
      }
      this.ctx.emit({ type: 'session.ended', reason: this.stopped ? 'interrupted' : 'completed' })
      this.ctx.setStatus('idle')
    } catch (err) {
      // Status before journal unlike normal path: journal writes may have killed runner; `running`
      // without runner would display in progress forever.
      this.ctx.setStatus(this.stopped ? 'idle' : 'error')
      journalDeath(
        this.ctx,
        this.stopped
          ? null
          : {
              type: 'error',
              code: 'runner_failed',
              message: err instanceof Error ? err.message : String(err),
              recoverable: false,
            },
      )
    } finally {
      this.clearTurnWatchdog()
      this.turnOpen = false
      this.interactions.expireAll()
    }
  }

  /**
   * Record upcoming tool write.
   *
   * Check existence synchronously now: only moment distinguishing creation/rewrite. Deferred reads
   * may resolve after write and observe changed disk.
   */
  private trackEdit(toolCallId: string, name: string, input: unknown): void {
    const path = editedPath(name, input)
    if (path === null) return

    this.pendingEdits.set(toolCallId, { path, existed: fileExists(path) })
  }

  /**
   * Open turn if none exists.
   *
   * Unlike Codex, Claude announces `result` at end but no start. Sillage-uninitiated turns (resume,
   * restart after live settings) skipped `setStatus('running')`, leaving database idle throughout
   * work. Open thread recovered by folding journal; conversation list has no journal and showed
   * nothing.
   */
  private openTurn(): void {
    if (this.turnOpen) return

    this.turnOpen = true
    this.ctx.emit({ type: 'turn.started' })
    this.ctx.setStatus('running')
  }

  /**
   * Force-close turn if CLI stops responding.
   *
   * `openTurn` establishes opening, but closing requires `result`, sometimes absent. Local slash
   * commands (`/model`) emit output without model turns; interruption with no real turn also emits
   * nothing. Conversation stayed busy: `isBusy` queued all following messages, idle reaper rearmed,
   * web indicator stayed because `turnRunning` resets only on `turn.completed`.
   *
   * Any CLI message disarms deadline: speaking implies active turn whose result will follow. Codex
   * has same interruption fallback for same reason.
   */
  private armTurnWatchdog(stopReason: string): void {
    this.clearTurnWatchdog()
    this.turnWatchdog = setTimeout(() => {
      this.turnWatchdog = null
      if (!this.turnOpen) return

      this.turnOpen = false
      this.ctx.emit({
        type: 'turn.completed',
        stopReason,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      })
      this.ctx.setStatus('idle')
    }, TURN_CLOSE_GRACE_MS)
    this.turnWatchdog.unref()
  }

  private clearTurnWatchdog(): void {
    if (this.turnWatchdog) clearTimeout(this.turnWatchdog)
    this.turnWatchdog = null
  }

  private translate(message: SDKMessage): void {
    this.clearTurnWatchdog()

    // Any CLI work message opens a turn: these three types carry agent text, tools, results.
    if (message.type === 'stream_event' || message.type === 'assistant' || message.type === 'user') {
      this.openTurn()
    }

    switch (message.type) {
      case 'system': {
        if (message.subtype === 'thinking_tokens') {
          // Counter resets each thinking block: lower values signal a new block, not regression.
          const estimated = message.estimated_tokens
          if (estimated < this.thinkingTokensSent) this.thinkingTokensSent = 0
          if (estimated - this.thinkingTokensSent < THINKING_TOKENS_STEP) return
          this.thinkingTokensSent = estimated
          this.ctx.emit({ type: 'thinking.progress', estimatedTokens: estimated })
          return
        }
        if (message.subtype === 'compact_boundary') {
          const meta = message.compact_metadata
          this.ctx.emit(
            {
              type: 'context.compacted',
              trigger: meta.trigger === 'manual' || meta.trigger === 'auto' ? meta.trigger : 'unknown',
              preTokens: meta.pre_tokens,
              postTokens: meta.post_tokens ?? null,
            },
            message,
          )
          return
        }
        if (message.subtype === 'status') {
          // CLI announces compaction whether requested through Sillage or automatic threshold.
          if (message.status === 'compacting') {
            this.ctx.emit({ type: 'context.compaction_started' }, message)
          }
          // Failure produces no compaction boundary: without forwarding, context stays full
          // silently.
          if (message.compact_result === 'failed') {
            this.ctx.emit(
              {
                type: 'error',
                code: 'compact_failed',
                message: message.compact_error ?? 'Context compaction failed.',
                recoverable: true,
              },
              message,
            )
          }
          return
        }
        // Only signal for work outside turn: workflows, background commands, backgrounded
        // subagents. Absent from message stream and `parentToolCallId`: workflow orchestration sits
        // above SDK subagent exposure.
        if (message.subtype === 'background_tasks_changed') {
          this.ctx.emit(
            {
              type: 'background.updated',
              tasks: message.tasks.map((task) => ({
                id: task.task_id,
                kind: task.task_type,
                description: task.description,
              })),
            },
            message,
          )
          return
        }
        if (message.subtype === 'task_started') {
          this.ctx.emit(
            {
              type: 'task.started',
              taskId: message.task_id,
              toolCallId: message.tool_use_id ?? null,
              // `task_type` absent for Task-launched subagents described by agent type. Fallback
              // keeps same family as top-level list.
              kind: message.task_type ?? 'local_agent',
              description: message.description,
            },
            message,
          )
          return
        }
        if (message.subtype === 'task_progress') {
          this.ctx.emit(
            {
              type: 'task.progress',
              taskId: message.task_id,
              activity: message.description,
              lastTool: message.last_tool_name ?? null,
              toolUses: message.usage.tool_uses,
              totalTokens: message.usage.total_tokens,
              durationMs: message.usage.duration_ms,
            },
            message,
          )
          return
        }
        if (message.subtype === 'task_notification') {
          this.ctx.emit(
            {
              type: 'task.completed',
              taskId: message.task_id,
              status: message.status,
              summary: message.summary,
              durationMs: message.usage?.duration_ms ?? null,
              ambient: message.skip_transcript ?? false,
            },
            message,
          )
          return
        }
        if (message.subtype === 'commands_changed') {
          this.publishCommands(message.commands)
          return
        }
        if (message.subtype === 'init') {
          if (message.permissionMode !== toPermissionMode(this.config.permissionMode)) {
            process.stderr.write(
              `[claude ${this.conversationId}] permission mode mismatch: requested=${toPermissionMode(this.config.permissionMode)} actual=${message.permissionMode} version=${message.claude_code_version}\n`,
            )
          }
          const first = this.sessionId === null
          this.sessionId = message.session_id
          this.ctx.setAgentSessionId(message.session_id)
          // Init `slash_commands` has names only. Completion needs descriptions/argument shapes,
          // supplied only by this request.
          if (first) void this.publishSupportedCommands()
          // CLI emits init every turn, not just launch: database counted equal `session.started`
          // and turns. Only first is startup; later journaled only on session/model changes,
          // revealing typed `/model`, fallback, `/clear` opening another session.
          const signature = `${message.session_id}\n${message.model}`
          if (signature !== this.initSignature) {
            this.initSignature = signature
            this.ctx.emit(
              {
                type: 'session.started',
                agent: 'claude',
                agentSessionId: message.session_id,
                model: message.model,
                cwd: message.cwd,
                tools: message.tools,
              },
              message,
            )
          }
          this.publishFastMode(message.fast_mode_state, message.fast_mode_disabled_reason)
          // Like `session.started`: init repeats per turn, notice only when failure list changes.
          const pluginErrors = JSON.stringify(message.plugin_errors ?? [])
          if (pluginErrors !== this.pluginErrorsSignature) {
            this.pluginErrorsSignature = pluginErrors
            const notice = describePluginErrors(message.plugin_errors)
            if (notice) this.ctx.emit(notice, message)
          }
          return
        }
        // Other system messages are signals or noise; `signals.ts` decides.
        this.emitSignal(message)
        return
      }

      case 'stream_event': {
        const event = message.event

        // `message.uuid` identifies stream event, not message: messageId would differ per token.
        // Only stable API ID arrives in message_start and final assistant message.
        //
        // Main/subagent streams interleave on same channel, so retain current ID per author. One ID
        // sufficed for one speaker, but subagent `message_start` overwrote it and subsequent main
        // text appended to subagent.
        const parentToolCallId = message.parent_tool_use_id
        if (event.type === 'message_start') {
          this.streamingMessageIds.set(parentToolCallId, event.message.id)
          return
        }
        if (event.type !== 'content_block_delta') return

        const messageId = this.streamingMessageIds.get(parentToolCallId)
        if (!messageId) return

        const delta = event.delta
        if (delta.type === 'text_delta') {
          this.ctx.emit({ type: 'message.delta', messageId, text: delta.text, parentToolCallId })
        } else if (delta.type === 'thinking_delta') {
          this.ctx.emit({ type: 'thinking.delta', messageId, text: delta.thinking, parentToolCallId })
        }
        return
      }

      case 'assistant': {
        const blocks: ContentBlock[] = []

        for (const block of message.message.content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text })
          } else if (block.type === 'thinking') {
            blocks.push({ type: 'thinking', text: block.thinking })
          } else if (block.type === 'tool_use') {
            this.durations.start(block.id)
            this.trackEdit(block.id, block.name, block.input)
            blocks.push({
              type: 'tool_use',
              toolCallId: block.id,
              name: block.name,
              input: block.input,
            })
            this.ctx.emit(
              {
                type: 'tool.started',
                toolCallId: block.id,
                name: block.name,
                input: block.input,
                parentToolCallId: message.parent_tool_use_id,
              },
              block,
            )
          }
        }

        if (blocks.length > 0) {
          this.ctx.emit(
            {
              type: 'message.completed',
              messageId: message.message.id,
              role: 'assistant',
              blocks,
              parentToolCallId: message.parent_tool_use_id,
            },
            message,
          )
        }
        return
      }

      case 'user': {
        // CLI user messages carry tool results; actual user input is journaled by send().
        const content = message.message.content
        if (typeof content === 'string') {
          // Remaining plain text comes from neither: CLI-reinjected instructions, typically due
          // loops or locally handled slash-command output.
          this.ctx.emit({ type: 'prompt.injected', text: content }, message)
          this.armTurnWatchdog('local_command')
          return
        }

        for (const block of content) {
          if (block.type !== 'tool_result') continue

          this.ctx.emit(
            {
              type: 'tool.completed',
              toolCallId: block.tool_use_id,
              output: block.content ?? null,
              isError: block.is_error === true,
              durationMs: this.durations.stop(block.tool_use_id),
            },
            block,
          )

          const edit = this.pendingEdits.get(block.tool_use_id)
          this.pendingEdits.delete(block.tool_use_id)
          // Failed calls wrote nothing: journaling edits would show nonexistent disk changes.
          if (edit && block.is_error !== true) {
            this.ctx.emit({
              type: 'file.edited',
              toolCallId: block.tool_use_id,
              path: toWorkspacePath(this.ctx.cwd, edit.path),
              action: edit.existed ? 'modified' : 'created',
            })
          }
        }
        return
      }

      case 'result': {
        // Failed turns explain before closing. CLI emits either error subtype with causes or
        // `is_error` “success” containing error text, such as exhausted quota. Without forwarding
        // both ended silently.
        if (message.subtype !== 'success') {
          this.ctx.emit(
            {
              type: 'error',
              code: message.subtype,
              message: message.errors.join('\n') || `The turn stopped: ${message.subtype}.`,
              recoverable: true,
            },
            message,
          )
        } else if (message.is_error) {
          this.ctx.emit(
            {
              type: 'error',
              code: 'turn_failed',
              message: message.result || 'The turn failed without an explanation from the CLI.',
              recoverable: true,
            },
            message,
          )
        }
        this.ctx.emit(
          {
            type: 'turn.completed',
            stopReason: message.subtype,
            costUsd: message.total_cost_usd,
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            // CLI context mostly uses cache: without both fields displayed totals do not reflect
            // usage.
            cacheCreationTokens: message.usage.cache_creation_input_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens,
          },
          message,
        )
        this.turnOpen = false
        this.ctx.setStatus('idle')
        // Each `result` carries Fast state including rate-limit cooldown, revealing mid-turn
        // changes.
        this.publishFastMode(message.fast_mode_state, message.fast_mode_disabled_reason)
        // Context requires CLI query; `result` omits it. Query afterward to avoid delaying turn
        // completion.
        void this.emitContextUsage()
        return
      }

      case 'rate_limit_event': {
        const info = message.rate_limit_info
        this.ctx.emit(
          {
            type: 'usage.updated',
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            rateLimit: {
              type: info.rateLimitType ?? 'unknown',
              status: info.status,
              // CLI `resetsAt` uses seconds, Sillage milliseconds: conversion prevents UI dates in
              // 1970.
              utilization: info.utilization ?? null,
              resetsAt: info.resetsAt === undefined ? null : info.resetsAt * 1000,
            },
          },
          message,
        )
        return
      }

      default: {
        const subtype = 'subtype' in message ? String(message.subtype) : message.type
        if (IGNORED_SUBTYPES.has(subtype)) return
        // Untranslated types are not journaled: journal drives display (I2), so unrenderable events
        // only add unread volume. Missing visible content belongs in translated `signals.ts`, not
        // another raw row.
        this.emitSignal(message)
        return
      }
    }
  }

  /** Forward CLI signals (see `signals.ts`); ignore nonsignals. */
  private emitSignal(message: SDKMessage): void {
    const event = translateSignal(message)
    if (event) this.ctx.emit(event, message)
  }

  /**
   * Journal Fast state only on change.
   *
   * CLI repeats on every init/result; one notice per turn says same thing twenty times. `undefined`
   * means CLI does not know feature.
   */
  private publishFastMode(
    state: FastModeState | undefined,
    reason: FastModeDisabledReason | undefined,
  ): void {
    if (state === undefined) return
    const current = { state, reason: reason ?? null }
    if (this.fastMode?.state === current.state && this.fastMode.reason === current.reason) return

    const previous = this.fastMode?.state ?? null
    this.fastMode = current
    const event = describeFastMode(state, current.reason, this.config.fastMode, previous)
    if (event) this.ctx.emit(event)
  }

  /** Context occupancy through control request. Errors must break nothing: indicator, not turn step. */
  private async emitContextUsage(): Promise<void> {
    if (!this.session) return
    try {
      const usage = await this.session.getContextUsage()
      this.ctx.emit({
        type: 'usage.updated',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        context: {
          usedTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          // CLI provides percentage; schema stores 0–1 ratio.
          ratio: usage.percentage / 100,
        },
      })
    } catch {
      // Session already closed or CLI too old for control request.
    }
  }

  /**
   * All CLI user prompts pass here, including nonpermissions: two tools ask questions/approve
   * plans. Treating them as permissions would put Allow/Deny on multiple-choice questions.
   *
   * Field instead of method: SDK calls reference without binding instance.
   */
  private readonly handleToolRequest: CanUseTool = (toolName, input, options) => {
    if (toolName === ASK_USER_QUESTION) return this.requestQuestion(input)
    if (toolName === EXIT_PLAN_MODE) return this.requestPlanReview(input)
    return this.requestPermission(toolName, input, options)
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    // Omit tool arguments: diagnostic logs must not copy commands potentially containing secrets.
    if (this.config.permissionMode === 'bypassPermissions') {
      process.stderr.write(
        `[claude ${this.conversationId}] unexpected permission request: tool=${toolName} mode=bypassPermissions\n`,
      )
    }
    /**
     * CLI-proposed permission updates prevent repeat prompts. Without forwarding, “allow for
     * session” allows only this call and asks identically next time.
     */
    const suggestions = options.suggestions ?? []

    return new Promise<PermissionResult>((resolve) => {
      this.interactions.requestPermission(
        {
          toolName,
          input,
          // CLI supplies labels explaining out-of-directory paths, triggered rules, requested
          // scope. Rebuilding phrases from tool names loses this.
          title: options.title ?? null,
          description: options.description ?? null,
          displayName: options.displayName ?? null,
        },
        (decision) => {
          if (decision === null) {
            resolve({ behavior: 'deny', message: 'Session terminée avant la réponse.' })
          } else if (decision.decision === 'allowed') {
            // One-time approval changes no rules; broader approval returns CLI-proposed updates,
            // only way to stop repeat prompts.
            resolve({
              behavior: 'allow',
              ...(decision.scope === 'once' ? {} : { updatedPermissions: suggestions }),
            })
          } else {
            resolve({ behavior: 'deny', message: 'Refusé depuis Sillage.' })
          }
        },
      )
    })
  }

  private requestQuestion(input: Record<string, unknown>): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.interactions.requestQuestion(toQuestions(input), (answer) => {
        if (answer === null || answer.status === 'cancelled') {
          // Allow without answers: CLI emits “The user did not answer the questions” and model
          // continues. Denial would turn legitimate cancellation into tool error.
          resolve({ behavior: 'allow' })
        } else {
          resolve({
            behavior: 'allow',
            // Augment original input with answer rather than replacing it.
            updatedInput: toUpdatedInput(input, answer.answers),
          })
        }
      })
    })
  }

  private requestPlanReview(input: Record<string, unknown>): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.interactions.requestPlanReview(
        { plan: toPlan(input), followUpOptions: PLAN_FOLLOW_UP_OPTIONS },
        (review) => {
          if (review === null) {
            resolve({ behavior: 'deny', message: 'Session terminée avant la réponse.' })
            return
          }
          if (review.decision === 'rejected') {
            resolve({
              behavior: 'deny',
              message: "Plan refusé : continue à planifier sans rien exécuter.",
            })
            return
          }

          // Leaving plan mode does not choose continuation: without changing mode, agent returns to
          // planning. Revalidate client value: unknown IDs mean no mode change, not invented modes.
          const parsed = claudePermissionModeSchema.safeParse(review.followUpMode)
          const mode = parsed.success ? parsed.data : null
          resolve({
            behavior: 'allow',
            ...(mode
              ? {
                  updatedPermissions: [
                    { type: 'setMode', mode: toPermissionMode(mode), destination: 'session' },
                  ],
                }
              : {}),
          })
          if (mode) {
            this.config = { ...this.config, permissionMode: mode }
            // Persist immediately: mode must outlive runner, otherwise settings show old mode and
            // resume plans again.
            this.ctx.updateConfig(this.config)
          }
        },
      )
    })
  }

  answerQuestion(requestId: string, answer: QuestionAnswer): boolean {
    return this.interactions.resolveQuestion(requestId, answer)
  }

  /**
   * Pure observer records armed loops and returns without deciding.
   *
   * Turn-end cadence suffices: scheduled tasks fire only between turns, never during. Each end sees
   * all possible changes when they happen.
   *
   * Field rather than method: SDK calls reference directly.
   */
  private readonly handleStop: HookCallback = async (input) => {
    if (input.hook_event_name === 'Stop') {
      this.ctx.emit({
        type: 'loops.updated',
        loops: (input.session_crons ?? []).map((cron) => ({
          id: cron.id,
          schedule: cron.schedule,
          recurring: cron.recurring,
          prompt: cron.prompt,
        })),
      })
      // Servers may fail or finish authentication mid-session; otherwise inventory would remain
      // startup snapshot.
      void this.publishMcpStatus()
    }
    return { continue: true }
  }

  /**
   * Publish MCP inventory as CLI sees it.
   *
   * Query rather than infer from supplied config: only way to discover startup failures and servers
   * loaded from CLI disk that user receives without declaring here.
   */
  private async publishMcpStatus(): Promise<void> {
    const session = this.session
    if (!session) return

    try {
      // Servers skipped for missing secrets never reached CLI and cannot be reported; add them so
      // failures remain visible instead of vanishing.
      this.ctx.emit({
        type: 'mcp.updated',
        servers: [...this.mcpFailures, ...fromSdkMcpStatus(await session.mcpServerStatus())],
      })
    } catch (err) {
      // Missing inventory must not kill session: conversation works, only status screen lags.
      process.stderr.write(
        `[claude ${this.conversationId}] inventaire MCP indisponible : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  /**
   * Publish session-recognized slash commands.
   *
   * CLI pushes list changes itself; explicitly request only at startup before any push.
   */
  private async publishSupportedCommands(): Promise<void> {
    const session = this.session
    if (!session) return

    try {
      this.publishCommands(await session.supportedCommands())
    } catch (err) {
      // Missing list only costs completion: fully typed commands still send. No reason to fail
      // session.
      process.stderr.write(
        `[claude ${this.conversationId}] commandes indisponibles : ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  private publishCommands(commands: SlashCommand[]): void {
    this.ctx.emit({ type: 'commands.updated', commands: toCommandDtos(commands) })
  }

  /**
   * MCP elicitation: server requests user input.
   *
   * Separate from `canUseTool`: neither tool permission nor agent question, but third-party MCP
   * request. Without callback CLI declines automatically, rejecting without user decision.
   *
   * Field rather than method: SDK calls reference directly.
   */
  private readonly handleElicitation = (request: ElicitationRequest): Promise<ElicitationResult> => {
    return new Promise<ElicitationResult>((resolve) => {
      this.interactions.requestElicitation(
        {
          serverName: request.serverName,
          // SDK `mode` optional; form is historical default.
          mode: request.mode === 'url' ? 'url' : 'form',
          message: request.message,
          url: request.url ?? null,
          fields: parseElicitationFields(request.requestedSchema),
          title: request.title ?? null,
        },
        (answer) => {
          if (answer === null) {
            // `cancel`, not `decline`: MCP distinguishes explicit refusal from requests reaching
            // nobody.
            resolve({ action: 'cancel' })
            return
          }
          // Only acceptance carries content: MCP defines none for denial/cancellation.
          resolve(
            answer.action === 'accept'
              ? { action: 'accept', content: answer.content }
              : { action: answer.action },
          )
        },
      )
    })
  }

  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean {
    return this.interactions.resolveElicitation(requestId, answer)
  }

  reviewPlan(requestId: string, review: PlanReview): boolean {
    // Normalize before journaling: client value is opaque to shared schema. Unknown IDs mean no
    // mode change; journal must record that interpretation, not invented string.
    const parsed = claudePermissionModeSchema.safeParse(review.followUpMode)
    return this.interactions.resolvePlanReview(requestId, {
      ...review,
      followUpMode: parsed.success ? parsed.data : null,
    })
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.interactions.resolvePermission(requestId, decision)
  }

  /**
   * No mention handling here: Claude expands `@path` relative to cwd itself. Probed installed CLI
   * with mentioned-file question and all tools denied: answer arrived without tools, so context
   * already contained content.
   *
   * No skills either: Claude exposes slash commands sent in text. Nothing publishes them here, so
   * list arrives empty.
   */
  async send(
    text: string,
    attachments: OutgoingAttachment[],
    _mentions: OutgoingMention[],
    _skills: string[],
  ): Promise<void> {
    const { blocks, prompt } = await buildUserMessage(text, attachments)

    this.ctx.emit({
      type: 'message.completed',
      messageId: randomUUID(),
      role: 'user',
      blocks,
      parentToolCallId: null,
    })
    this.openTurn()

    this.input.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)
  }

  /**
   * Steer active turn.
   *
   * No dedicated request like Codex `turn/steer`: ordinary stream carries message; `priority`
   * controls placement. `next` folds into current turn at next tool-batch boundary, prefixed “The
   * user sent a new message while you were working”. `later` waits for next turn, already handled
   * by queue.
   *
   * Write explicit `next`, though default: only difference from send, and readers must see it.
   *
   * Two installed-CLI probe limits absent from docs: only tool-batch boundaries fold messages, so
   * final answers without further calls finish before message starts next turn. Stream never
   * reports which happened: `true` means sent during open turn, not guaranteed redirection.
   */
  async steer(
    text: string,
    attachments: OutgoingAttachment[],
    _mentions: OutgoingMention[],
    _skills: string[],
  ): Promise<boolean> {
    if (!this.session || !this.turnOpen) return false

    const { blocks, prompt } = await buildUserMessage(text, attachments)

    this.ctx.emit({
      type: 'message.completed',
      messageId: randomUUID(),
      role: 'user',
      blocks,
      parentToolCallId: null,
    })

    // Unlike send, no `openTurn()`: existing turn is precondition; opening another miscounts.
    this.input.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
      priority: 'next',
    } as SDKUserMessage)

    return true
  }

  /**
   * Compaction.
   *
   * Claude exposes no control request: `/compact` is slash command in ordinary user message, using
   * same channel and producing a turn.
   *
   * Do not journal as user content: command addresses CLI, not something user told agent.
   */
  async compact(): Promise<boolean> {
    if (!this.session) return false

    this.openTurn()
    this.input.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)

    return true
  }

  /**
   * SDK `stopTask` control request. CLI closes task and publishes remaining
   * `background_tasks_changed`; nothing to emit here, journal learns stopping through same path as
   * starting.
   */
  async stopBackgroundTask(taskId: string): Promise<boolean> {
    if (!this.session) return false
    try {
      await this.session.stopTask(taskId)
    } catch {
      // Normal race: task finished between click/request, CLI no longer knows it. Same as absent
      // session, not error.
      return false
    }
    return true
  }

  /** SDK control requests apply these settings without restarting CLI, preserving loaded context. */
  async applyConfig(config: AgentConfig): Promise<boolean> {
    if (config.agent !== 'claude' || !this.session) return false

    // `strictMcpConfig` is launch-only; no control request toggles it. Rejection triggers runner
    // restart/resume with correct value.
    if (config.strictMcp !== this.config.strictMcp) return false

    // Leaving `bypassPermissions` requires restart like entering. Launch grants bypass;
    // `set_permission_mode` accepts new mode but changes nothing: canUseTool never called,
    // conversation still allows everything under opposite displayed setting. Unlike reverse
    // direction failing clearly, this looked applied and never restarted.
    if (this.launchedWithBypass !== (config.permissionMode === 'bypassPermissions')) return false

    // Budget caps are launch-only without control updates, same as strictMcp.
    if (config.maxBudgetUsd !== this.config.maxBudgetUsd || config.maxTurns !== this.config.maxTurns) {
      return false
    }

    // Account too: token comes through process environment read at launch.
    if (config.account !== this.config.account) return false

    // Library plugins too. Compare actual received roots, not just toggle.
    if (JSON.stringify(this.ctx.skillRoots(config)) !== JSON.stringify(this.skillRoots)) return false

    await this.session.setModel(config.model)
    await this.session.applyFlagSettings(liveFlagSettings(this.config, config))
    await this.session.setPermissionMode(toPermissionMode(config.permissionMode))

    // Compare resolved servers, not IDs: registry entries corrected meanwhile must restart even
    // with identical ID list.
    const resolved = this.ctx.resolveMcpServers(config)
    const desired = toSdkMcpServers(resolved.servers)
    if (JSON.stringify(desired) !== JSON.stringify(this.appliedMcpServers)) {
      await this.session.setMcpServers(desired)
      this.appliedMcpServers = desired
      this.mcpFailures = failedStatuses(resolved.failures)
      await this.publishMcpStatus()
    }

    this.config = config
    return true
  }

  /**
   * Probed: skills added to running plugins remain unseen until requested; `reloadSkills()`
   * suffices without invalidating prompt cache. CLI then pushes `commands_changed`, refreshing
   * composer.
   */
  async reloadSkillLibrary(): Promise<void> {
    if (!this.session || this.skillRoots.length === 0) return
    await this.session.reloadSkills()
  }

  /**
   * Claude summarizes from first turn and saves beside transcript. Read via `getSessionInfo`, not
   * SessionStart hook: hooks fork processes per event, excluded by memory budget.
   */
  async suggestedTitle(): Promise<string | null> {
    const sessionId = this.sessionId
    if (!sessionId) return null

    try {
      const info = await getSessionInfo(sessionId, { dir: this.ctx.cwd })
      const title = info?.customTitle ?? info?.summary ?? null
      return title && title.trim().length > 0 ? title.trim() : null
    } catch {
      // Missing titles are not failures: conversation retains its own.
      return null
    }
  }

  async interrupt(): Promise<void> {
    await this.session?.interrupt()
    this.ctx.setStatus('idle')

    // Do not close turn here: CLI interruption of live turn returns result, carrying turn.completed
    // to reset web indicator. Closing early changes status without thread knowing, leaving
    // activity/Stop visible and action apparently ineffective. Without real active turn no result
    // arrives; fallback closes it.
    this.armTurnWatchdog('interrupted')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTurnWatchdog()
    this.input.close()
    this.abort.abort()
    this.interactions.expireAll()
  }
}
