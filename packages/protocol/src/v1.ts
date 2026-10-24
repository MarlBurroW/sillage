import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config.js'
import { conversationStatusSchema } from './api.js'
import { elicitationActionSchema, elicitationContentSchema } from './elicitation.js'
import { agentKindSchema, type AgentKind, type SillageEvent } from './events.js'

/**
 * Public API driven by machine clients.
 *
 * It speaks of tasks where the rest of Sillage speaks of conversations: the same object, table
 * and journal, but remote callers should not know UI DTOs that evolve with screens. This
 * translation is the price of a stable contract.
 *
 * Watch the vocabulary: journal events `task.started` and `task.completed` already denote CLI
 * background jobs, not tasks in this API's sense.
 */

/** The caller supplies a prompt; everything else is resolved. */
export const createTaskBodySchema = z.object({
  prompt: z.string().min(1),
  /** Default: CLI chosen when creating the token. */
  agent: agentKindSchema.optional(),
  /**
   * Partial override in the target CLI's native vocabulary. Deliberately not unified: Claude
   * `effort` and Codex `reasoningEffort` accept different values, so a shared field would
   * mislead. `GET /api/v1/agents` publishes accepted values.
   *
   * Only `OVERRIDABLE_CONFIG_FIELDS` are accepted: safeguards cannot be configured per request.
   */
  config: z.record(z.string(), z.unknown()).optional(),
  worktreeId: z.string().nullable().default(null),
  title: z.string().max(200).optional(),
  /** Overrides the token's webhook URL for this task. Signed with the same secret. */
  webhookUrl: z.string().url().optional(),
  /**
   * How long an input request waits before the v1 layer declines it and interrupts the task. 0
   * disables the deadline: the task waits like a human conversation, occupying a session slot.
   */
  replyDeadlineSec: z.number().int().min(0).max(86_400).optional(),
})

/** Default deadline for API tasks that request no override. */
export const DEFAULT_REPLY_DEADLINE_SEC = 600

/**
 * Answer to an input request, all four kinds through one route.
 *
 * The body names the expected kind rather than guessing: a caller answering `permission` to
 * what became a question must be rejected, not reinterpreted. Decision vocabulary matches
 * native routes (`allowed`, `approved`, etc.), avoiding a second vocabulary to document.
 */
export const taskReplyBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    decision: z.enum(['allowed', 'denied']),
    scope: z.enum(['once', 'session', 'always']).default('once'),
  }),
  z.object({
    kind: z.literal('question'),
    status: z.enum(['answered', 'cancelled']).default('answered'),
    answers: z.record(z.string(), z.array(z.string())).default({}),
  }),
  z.object({
    kind: z.literal('plan'),
    decision: z.enum(['approved', 'rejected']),
    followUpMode: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('elicitation'),
    action: elicitationActionSchema,
    content: elicitationContentSchema.default({}),
  }),
])
export type TaskReplyBody = z.infer<typeof taskReplyBodySchema>

export const taskMessageBodySchema = z.object({
  prompt: z.string().min(1),
})

/**
 * Steering exists only during a turn, and machine clients can lose the race: read `running`,
 * send, but the turn has already ended. `queue` then falls back to a normal message rather than
 * dropping the text.
 */
export const taskSteerBodySchema = z.object({
  prompt: z.string().min(1),
  onMissedTurn: z.enum(['queue', 'fail']).default('queue'),
})

export const taskListQuerySchema = z.object({
  status: conversationStatusSchema.optional(),
  projectId: z.string().optional(),
  /** By default, only tasks launched by the calling token. */
  scope: z.enum(['token', 'user']).default('token'),
})

export const taskEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  /** Comma-separated type list. Empty means everything except deltas. */
  types: z.string().optional(),
})

/** Types too verbose for polling clients: they arrive token by token. */
export const V1_NOISY_EVENT_TYPES = [
  'message.delta',
  'thinking.delta',
  'thinking.progress',
  'tool.output_delta',
] as const

export interface TaskProjectDto {
  id: string
  name: string
  workspacePath: string
  /** True if the workspace is a git repository, allowing worktrees. */
  git: boolean
  worktrees: { id: string; name: string; branch: string }[]
  /** Defaults used by a task launched on this project when unspecified. */
  defaults: { agent: AgentKind; config: unknown }
}

/**
 * CLI-supported overrides so callers need not guess.
 *
 * `effortField` names the field rather than normalizing it: Claude uses `effort`, Codex
 * `reasoningEffort`, with different values. Describing native keys informs without inventing a
 * misleading abstraction.
 */
export interface TaskAgentDto {
  agent: AgentKind
  label: string
  available: boolean
  effortField: string
  models: { value: string; displayName: string; isDefault: boolean; efforts: string[] }[]
  /** Accepted `outputStyle` values (Claude); empty if unsupported. */
  outputStyles: string[]
}

/** Current tool call while the agent is working. */
export interface TaskActivityDto {
  toolCallId: string
  toolName: string
  startedAt: number
  /** True if the call comes from a sub-agent rather than the main thread. */
  nested: boolean
}

export interface TaskPendingDto {
  kind: 'permission' | 'question' | 'plan' | 'elicitation'
  requestId: string
  requestedAt: number
  /** Request as journaled, requiring no further translation. */
  event: SillageEvent
}

/**
 * A listed task without folded state.
 *
 * Folding costs one journal read per task; counting turns requires a full traversal. Acceptable
 * for one inspected task, prohibitively expensive for fifty listed tasks. Listings therefore
 * expose existing table data; `GET /tasks/:id` provides a specific task's current state.
 */
export interface TaskSummaryDto {
  id: string
  projectId: string
  worktreeId: string | null
  title: string
  status: z.infer<typeof conversationStatusSchema>
  agent: AgentKind
  lastSeq: number
  usage: { costUsd: number; inputTokens: number; outputTokens: number }
  url: string
  createdAt: number
  updatedAt: number
}

/**
 * Already-folded task state.
 *
 * The raw journal does not answer “where is it now?” without folding. The UI has a full fold
 * for that, while event-reading clients mostly see deltas. This is the view callers poll;
 * `/events` remains available for details.
 */
export interface TaskDto extends TaskSummaryDto {
  /** Resolved configuration: what the task actually runs with. */
  config: unknown
  turns: number
  activity: TaskActivityDto | null
  lastMessage: { text: string; at: number } | null
  pending: TaskPendingDto | null
}

export interface TaskEventsPageDto {
  taskId: string
  events: { seq: number; ts: number; event: SillageEvent }[]
  /** Cursor to pass as `after` on the next request. */
  nextAfter: number
  hasMore: boolean
}

// Webhooks

/**
 * WATCH THE VOCABULARY. Journal events `task.started`, `task.progress` and `task.completed`
 * describe CLI background jobs (workflows, background commands), not tasks in this API's sense.
 * The types below appear ONLY in webhook deliveries, never in the journal. Consumers reading
 * both must distinguish them by channel.
 */
export type WebhookEventType =
  | 'task.completed'
  | 'task.awaiting_input'
  | 'task.failed'
  | 'task.stopped'

export type WebhookFailureReason = 'runner_failed' | 'reply_deadline_exceeded' | 'session_ended'

/**
 * Webhook delivery body.
 *
 * `seq` reorders deliveries received out of order after recovery; `clientMessageId` identifies
 * the message that opened the turn. A UI message on an agent task produces an unsolicited
 * `task.completed` that callers cannot interpret without this correlation. Null if the server
 * restarted between send and turn completion, or the turn did not originate from the API.
 */
export interface WebhookPayload {
  type: WebhookEventType
  taskId: string
  projectId: string
  seq: number
  ts: number
  clientMessageId: string | null
  status: z.infer<typeof conversationStatusSchema>
  title: string
  url: string
  /** task.completed */
  stopReason?: string
  lastMessage?: string | null
  /**
   * Background jobs still active at turn end. Currently always 0: turns leaving background work
   * are not delivered at all; the final turn's delivery suffices. Retained in the contract so
   * consumers can rely on it if policy changes later.
   */
  backgroundJobs?: number
  /** task.awaiting_input */
  pending?: { kind: TaskPendingDto['kind']; requestId: string; event: SillageEvent }
  /** Answer deadline; absent for tasks without one. */
  replyDeadlineAt?: number
  /** task.failed */
  reason?: WebhookFailureReason
  message?: string
  /** task.stopped: who took control. Never the calling token itself. */
  by?: { kind: 'user' | 'token'; label: string }
}

/**
 * Effort field name in each CLI's configuration.
 *
 * Exhaustive table instead of branching: adding a CLI fails compilation here, preferable to
 * publishing an API that silently omits a setting.
 */
export const EFFORT_FIELD: Record<AgentKind, string> = {
  claude: 'effort',
  codex: 'reasoningEffort',
  opencode: 'variant',
  grok: 'reasoningEffort',
  antigravity: 'reasoningEffort',
}

/**
 * Fields a request may change, per CLI.
 *
 * Allowlist, not denylist, so omissions fail safely: new `AgentConfig` fields are rejected
 * until listed rather than becoming overridable without a decision.
 *
 * Unlisted fields are safeguards (permission mode, approval, sandbox, extra directories, MCP
 * servers), configured when creating the token in the UI. Without this boundary, callers could
 * request `permissionMode: bypassPermissions` or `sandbox: danger-full-access` and turn the
 * token into shell access.
 *
 * The same applies to costly features: fast mode and the advisor model spend the machine
 * account's resources, not the caller's, so remain token settings. Budget caps work the other
 * way, only reducing task spending, so callers may set them.
 */
export const OVERRIDABLE_CONFIG_FIELDS: Record<AgentKind, readonly string[]> = {
  claude: ['model', 'effort', 'outputStyle', 'maxBudgetUsd', 'maxTurns'],
  codex: ['model', 'reasoningEffort', 'collaborationMode'],
  opencode: ['model', 'variant', 'primaryAgent'],
  grok: ['model', 'reasoningEffort'],
  antigravity: ['model', 'reasoningEffort'],
}

/**
 * A configuration without CLI safeguards: everything executes without asking. Requires
 * `tasks:autonomous` regardless of source: token settings, project baseline or override. Check
 * the resolved configuration so no indirect path bypasses enforcement.
 */
export function isPermissiveConfig(config: AgentConfig): boolean {
  if (config.agent === 'claude') return config.permissionMode === 'bypassPermissions'
  // The sentinel counts as permissive: without a Sillage rule, opencode allows actions
  // unless overridden by machine settings that cannot be known here.
  if (config.agent === 'opencode') {
    return config.permissions.edit !== 'ask' && config.permissions.edit !== 'deny' &&
      config.permissions.bash !== 'ask' && config.permissions.bash !== 'deny'
  }
  // `auto` lets a classifier decide without asking, equivalent for unattended callers:
  // only `default` and `plan` retain human involvement.
  if (config.agent === 'antigravity') return config.permissionMode === 'yolo'
  if (config.agent === 'grok') return config.permissionMode === 'bypassPermissions' || config.permissionMode === 'auto'
  return config.askForApproval === 'never' || config.sandbox === 'danger-full-access'
}

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>
export type TaskSteerBody = z.infer<typeof taskSteerBodySchema>

/**
 * Merges an override into resolved configuration, then validates the result.
 *
 * Fields outside the allowlist are reported to callers rather than silently ignored: believing
 * a safeguard was disabled would be worse than an explicit rejection.
 */
export function mergeAgentConfig(
  base: AgentConfig,
  override: Record<string, unknown> | undefined,
): { config: AgentConfig; rejected: string[] } {
  if (!override) return { config: agentConfigSchema.parse(base), rejected: [] }

  const allowed = OVERRIDABLE_CONFIG_FIELDS[base.agent]
  const rejected = Object.keys(override).filter((field) => !allowed.includes(field))
  if (rejected.length > 0) return { config: base, rejected }

  const merged: Record<string, unknown> = { ...base }
  for (const field of allowed) {
    if (field in override) merged[field] = override[field]
  }
  return { config: agentConfigSchema.parse(merged), rejected: [] }
}
