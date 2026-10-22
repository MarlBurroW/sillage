import { Cron } from 'croner'
import { z } from 'zod'
import { DEFAULT_DECISION_HOURS, MAX_DECISION_HOURS } from './decisions.js'
import { agentConfigSchema, type AgentConfig } from './agent-config.js'
import { cronScheduleSchema } from './app-settings.js'
import { agentKindSchema, type AgentKind } from './events.js'
import { automationTemplateIdSchema, webhookSettingsSchema, type WebhookAutomationDto } from './automations.js'

/**
 * Scheduled tasks: a prompt replayed by the daemon at a fixed cadence, each run in a fresh
 * session.
 *
 * Limits live here rather than on the server because the form displays them and the
 * `schedule_task` MCP tool must reject the same inputs as the route.
 */

/** Below this, the next run arrives before the last finishes: a loop, not a task. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 1
/** One year: beyond this, use a date rather than an interval. */
export const MAX_SCHEDULE_INTERVAL_MINUTES = 366 * 24 * 60

export const MIN_SCHEDULE_DURATION_MINUTES = 1
export const MAX_SCHEDULE_DURATION_MINUTES = 24 * 60
/** Enough for an audit, too short for a wandering agent to consume a whole night. */
export const DEFAULT_SCHEDULE_DURATION_MINUTES = 30

export const MAX_SCHEDULE_NAME_CHARS = 120
/** Same limit as a `start_session` mission: beyond this, use a file referenced by the prompt. */
export const MAX_SCHEDULE_PROMPT_CHARS = 20000

/**
 * Pre-turn check: a script the daemon runs before opening the session, waking the LLM only when
 * there is work to do.
 *
 * The contract is the exit code: `0` starts the turn, `CHECK_SKIP_EXIT_CODE` skips it without a
 * session, and any other code is an error. A dedicated “nothing to do” code rather than `1`:
 * crashes commonly exit 1, and must not silently look like “nothing new”.
 */
export const CHECK_SKIP_EXIT_CODE = 10
export const MAX_CHECK_SCRIPT_CHARS = 20000
export const MIN_CHECK_TIMEOUT_SECONDS = 5
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 120
export const MAX_CHECK_TIMEOUT_SECONDS = 1800
/** Maximum stdout contribution to the prompt; truncated beyond this. */
export const MAX_CHECK_OUTPUT_CHARS = 20000

/** Empty or null removes the check: clearing the form field means “none”. */
export const checkScriptSchema = z
  .string()
  .max(MAX_CHECK_SCRIPT_CHARS)
  .nullable()
  .transform((value) => (value && value.trim() ? value : null))
export const checkTimeoutSchema = z.number().int().min(MIN_CHECK_TIMEOUT_SECONDS).max(MAX_CHECK_TIMEOUT_SECONDS)

/**
 * When a task runs.
 *
 * Three forms rather than cron alone: “every 6 hours” counts from the previous run, which a
 * cron expression cannot express; a one-time date has no cron expression at all. Cron times use
 * the server timezone.
 */
export const scheduleCadenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    minutes: z.number().int().min(MIN_SCHEDULE_INTERVAL_MINUTES).max(MAX_SCHEDULE_INTERVAL_MINUTES),
  }),
  z.object({ kind: z.literal('cron'), expression: cronScheduleSchema }),
  z.object({ kind: z.literal('once'), at: z.number().int().positive() }),
  // No scheduled time: the task runs when its webhook receives a call passing its
  // conditions. Configuration lives separately; see `automations.ts`.
  z.object({ kind: z.literal('webhook') }),
])
export type ScheduleCadence = z.infer<typeof scheduleCadenceSchema>

/**
 * A run due while the previous one is active: `skip` drops it, `wait` starts it when the slot
 * frees up. Never two in parallel: they would work in the same tree.
 */
export const scheduleOverlapPolicySchema = z.enum(['skip', 'wait'])
export type ScheduleOverlapPolicy = z.infer<typeof scheduleOverlapPolicySchema>

/** `fresh`: a new session per run. Continuous mode will be added here later. */
export const scheduleExecutionModeSchema = z.enum(['fresh'])
export type ScheduleExecutionMode = z.infer<typeof scheduleExecutionModeSchema>

/** `checking`: the check is running, or its subsequent session is starting. */
export const scheduleRunStatusSchema = z.enum(['checking', 'running', 'succeeded', 'failed', 'timed_out', 'skipped'])
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>

export type ScheduleRunTrigger = 'schedule' | 'manual' | 'webhook'

export const createScheduledTaskBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_SCHEDULE_NAME_CHARS),
  agent: agentKindSchema,
  config: agentConfigSchema,
  prompt: z.string().trim().min(1).max(MAX_SCHEDULE_PROMPT_CHARS),
  cadence: scheduleCadenceSchema,
  overlapPolicy: scheduleOverlapPolicySchema.default('skip'),
  maxDurationMinutes: z
    .number()
    .int()
    .min(MIN_SCHEDULE_DURATION_MINUTES)
    .max(MAX_SCHEDULE_DURATION_MINUTES)
    .default(DEFAULT_SCHEDULE_DURATION_MINUTES),
  enabled: z.boolean().default(true),
  checkScript: checkScriptSchema.default(null),
  checkTimeoutSeconds: checkTimeoutSchema.default(DEFAULT_CHECK_TIMEOUT_SECONDS),
  /** The agent may request a decision, waiting at most this long. Disabled by default. */
  decisionsEnabled: z.boolean().default(false),
  decisionMaxHours: z.number().int().min(1).max(MAX_DECISION_HOURS).default(DEFAULT_DECISION_HOURS),
  /** For `webhook` cadence: starting template and supplemental settings. */
  webhook: z
    .object({
      template: automationTemplateIdSchema.optional(),
      settings: webhookSettingsSchema.partial().optional(),
    })
    .optional(),
})

/** All optional: pausing sends only `enabled`. */
export const updateScheduledTaskBodySchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_SCHEDULE_NAME_CHARS),
    agent: agentKindSchema,
    config: agentConfigSchema,
    prompt: z.string().trim().min(1).max(MAX_SCHEDULE_PROMPT_CHARS),
    cadence: scheduleCadenceSchema,
    overlapPolicy: scheduleOverlapPolicySchema,
    maxDurationMinutes: z
      .number()
      .int()
      .min(MIN_SCHEDULE_DURATION_MINUTES)
      .max(MAX_SCHEDULE_DURATION_MINUTES),
    enabled: z.boolean(),
    checkScript: checkScriptSchema,
    checkTimeoutSeconds: checkTimeoutSchema,
    decisionsEnabled: z.boolean(),
    decisionMaxHours: z.number().int().min(1).max(MAX_DECISION_HOURS),
  })
  .partial()

/**
 * Tests the script as currently entered in the form without launching anything, even before
 * saving. `taskId` tests against a copy of that task's state; without it, use empty state like
 * a first run.
 */
export const testScheduleCheckBodySchema = z.object({
  script: z.string().min(1).max(MAX_CHECK_SCRIPT_CHARS),
  timeoutSeconds: checkTimeoutSchema.default(DEFAULT_CHECK_TIMEOUT_SECONDS),
  taskId: z.string().optional(),
})

/**
 * Approval of an agent-proposed script. The reviewed text is returned: if it changed between
 * display and click, reject rather than approve unseen text.
 */
export const approveScheduleCheckBodySchema = z.object({
  script: z.string().min(1).max(MAX_CHECK_SCRIPT_CHARS),
})

/** “Run now”, with or without the check. */
export const runScheduleBodySchema = z.object({ skipCheck: z.boolean().default(false) }).default({})

/** Verdict derived from the exit code, the only thing the daemon interprets. */
export type ScheduleCheckVerdict = 'launch' | 'skip' | 'error'

export interface ScheduleCheckResultDto {
  verdict: ScheduleCheckVerdict
  /** Null if the script did not finish: timed out or could not start. */
  exitCode: number | null
  timedOut: boolean
  /** What the prompt receives, truncated to `MAX_CHECK_OUTPUT_CHARS`. */
  stdout: string
  stderr: string
  durationMs: number
}

/** Check outcome for a run. */
export interface ScheduledRunCheckDto {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

export interface ScheduledRunDto {
  id: string
  taskId: string
  /** Null if the run launched nothing or its thread was later deleted. */
  conversationId: string | null
  trigger: ScheduleRunTrigger
  status: ScheduleRunStatus
  scheduledFor: number
  startedAt: number
  finishedAt: number | null
  error: string | null
  /** Null if the run performed no check. */
  check: ScheduledRunCheckDto | null
}

/** Task check as displayed and submitted for approval by the UI. */
export interface ScheduledTaskCheckDto {
  script: string
  timeoutSeconds: number
  /** False until an agent-written script is reviewed: runs are skipped. */
  approved: boolean
  /** Conversation of the proposing agent; null when created in the UI. */
  proposedBy: string | null
}

export interface ScheduledTaskDto {
  id: string
  projectId: string
  userId: string
  name: string
  agent: AgentKind
  config: AgentConfig
  prompt: string
  cadence: ScheduleCadence
  executionMode: ScheduleExecutionMode
  overlapPolicy: ScheduleOverlapPolicy
  maxDurationMinutes: number
  enabled: boolean
  lastRunAt: number | null
  /** Null if nothing remains scheduled: paused, or a completed one-time task. */
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
  /** Latest runs, newest first. */
  runs: ScheduledRunDto[]
  /** Webhook settings for a call-triggered task; otherwise null. */
  webhook: WebhookAutomationDto | null
  /** Script run before each turn; null without a check. */
  check: ScheduledTaskCheckDto | null
  /** The agent may request a human decision with this maximum wait. */
  decisionsEnabled: boolean
  decisionMaxHours: number
}

/**
 * Next cadence occurrence after `after`, or null if none remains.
 *
 * Shared by the daemon, which schedules it, and the form, which previews it: separate
 * calculations would eventually show one time and trigger at another.
 *
 * `lastRunAt` applies only to intervals, counted from the previous run. Without it, the first
 * run waits a full interval: running an “every 6 hours” task immediately at creation would
 * surprise users; “run now” exists for that.
 */
export function nextScheduleRun(
  cadence: ScheduleCadence,
  after: number,
  lastRunAt: number | null = null,
): number | null {
  if (cadence.kind === 'webhook') return null
  if (cadence.kind === 'once') return cadence.at > after ? cadence.at : null
  if (cadence.kind === 'interval') {
    const step = cadence.minutes * 60_000
    const next = (lastRunAt ?? after) + step
    // A daemon stopped for several intervals does not catch up missed runs.
    return next > after ? next : after + step
  }
  try {
    return new Cron(cadence.expression, { paused: true }).nextRun(new Date(after))?.getTime() ?? null
  } catch {
    return null
  }
}
