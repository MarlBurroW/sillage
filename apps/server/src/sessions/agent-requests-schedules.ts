import { Cron } from 'croner'
import { count, eq } from 'drizzle-orm'
import { scheduledTasks, type ProjectRow } from '@sillage/db'
import {
  AUTOMATION_TEMPLATES,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  DEFAULT_SCHEDULE_DURATION_MINUTES,
  MAX_CHECK_SCRIPT_CHARS,
  MAX_CHECK_TIMEOUT_SECONDS,
  MAX_SCHEDULE_DURATION_MINUTES,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULE_PROMPT_CHARS,
  MIN_CHECK_TIMEOUT_SECONDS,
  MIN_SCHEDULE_DURATION_MINUTES,
  automationConditionsSchema,
  checkScriptSchema,
  checkTimeoutSchema,
  scheduleCadenceSchema,
  type ScheduleCadence,
  type WebhookSettings,
  type WebhookVerification,
} from '@sillage/protocol'
import { createWebhook, readSettings, revealSecret, webhookUrl } from '../automations/webhooks.js'
import type { AppContext } from '../http/context.js'
import { createScheduledTask } from '../scheduler/tasks.js'
import { describeEffort, describeModel, describePermissions, type LaunchConfigs } from './agent-requests-models.js'
import { describeZod, Refusal, type Requester } from './agent-requests-shared.js'

/** Unattended work agents set up: `schedule_task` and `create_automation`, with the caps that keep it from multiplying. */

/** Minimum agent-created schedule interval. Interfaces allow tighter intervals because humans choose them; misunderstood per-minute tasks could consume quotas before discovery. */
export const MIN_AGENT_SCHEDULE_MINUTES = 15

/** Per-project task cap beyond which agents cannot add more. */
export const MAX_AGENT_SCHEDULES_PER_PROJECT = 20

export class ScheduleRequests {
  constructor(
    private readonly ctx: AppContext,
    private readonly configs: LaunchConfigs,
    /** Webhook signing-secret key; absent means `create_automation` is rejected. */
    private readonly encryptionKey?: Buffer,
  ) {}

  // --- schedule_task -------------------------------------------------------------

  /** Creates scheduled tasks like interface forms. Model/effort choices remain available but permissions retain project defaults, especially important for unattended runs. Responses repeat them so agents can inform users. */
  async scheduleTask(
    requester: Requester,
    project: ProjectRow,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (requester.scheduleId) {
      throw new Refusal(
        'Refused: this session is itself a scheduled run. Tasks creating more tasks would multiply unattended; create a card with create_card instead.',
      )
    }

    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) throw new Refusal('The `name` parameter is required: a short task name.')
    if (name.length > MAX_SCHEDULE_NAME_CHARS) {
      throw new Refusal(`Name too long (maximum ${MAX_SCHEDULE_NAME_CHARS} characters).`)
    }
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) throw new Refusal('The `prompt` parameter is required: instructions replayed at each run.')
    if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS) {
      throw new Refusal(
        `Instructions too long (${prompt.length} characters, maximum ${MAX_SCHEDULE_PROMPT_CHARS}). Put details in a file and cite it.`,
      )
    }

    const [existing] = this.ctx.db
      .select({ total: count() })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.projectId, project.id))
      .all()
    if ((existing?.total ?? 0) >= MAX_AGENT_SCHEDULES_PER_PROJECT) {
      throw new Refusal(
        `Refused: this project already has ${MAX_AGENT_SCHEDULES_PER_PROJECT} scheduled tasks. The user can remove some in Scheduling.`,
      )
    }

    const cadence = parseAgentCadence(payload)
    const maxDurationMinutes = payload.max_duration_minutes ?? DEFAULT_SCHEDULE_DURATION_MINUTES
    if (
      typeof maxDurationMinutes !== 'number' ||
      !Number.isInteger(maxDurationMinutes) ||
      maxDurationMinutes < MIN_SCHEDULE_DURATION_MINUTES ||
      maxDurationMinutes > MAX_SCHEDULE_DURATION_MINUTES
    ) {
      throw new Refusal(
        `\`max_duration_minutes\` must be an integer between ${MIN_SCHEDULE_DURATION_MINUTES} and ${MAX_SCHEDULE_DURATION_MINUTES}.`,
      )
    }
    const overlap = payload.overlap ?? 'skip'
    if (overlap !== 'skip' && overlap !== 'wait') {
      throw new Refusal('`overlap` must be `skip` (skip this run) or `wait` (wait for the previous run to finish).')
    }
    const checkScript = checkScriptSchema.safeParse(payload.check_script ?? null)
    if (!checkScript.success) {
      throw new Refusal(`\`check_script\` is the script text, at most ${MAX_CHECK_SCRIPT_CHARS} characters.`)
    }
    const checkTimeout = checkTimeoutSchema.safeParse(payload.check_timeout_seconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS)
    if (!checkTimeout.success) {
      throw new Refusal(
        `\`check_timeout_seconds\` must be an integer between ${MIN_CHECK_TIMEOUT_SECONDS} and ${MAX_CHECK_TIMEOUT_SECONDS}.`,
      )
    }

    const agent = this.configs.parseAgent(payload.agent, requester.agent)
    const config = await this.configs.launchConfig(agent, project, requester.userId, payload, requester.apiToken)
    const task = createScheduledTask(
      this.ctx.db,
      { projectId: project.id, userId: requester.userId, conversationId: requester.id || undefined },
      {
        name,
        agent,
        config,
        prompt,
        cadence,
        overlapPolicy: overlap,
        maxDurationMinutes,
        enabled: true,
        checkScript: checkScript.data,
        checkTimeoutSeconds: checkTimeout.data,
      },
    )

    const lines = [
      `Scheduled task “${task.name}” created, id ${task.id}.`,
      `Cadence: ${describeCadence(cadence)}. Next run: ${task.nextRunAt ? new Date(task.nextRunAt).toISOString() : 'none'}.`,
      `Each run opens a new session: CLI ${agent}, model ${describeModel(config)}, effort ${describeEffort(config)}, maximum ${task.maxDurationMinutes} min, at the project root.`,
      describePermissions(config)
        ? 'Warning: with project default permissions, runs may stop for approval nobody will provide, until their maximum duration. Tell the user to adjust task permissions in Scheduling.'
        : null,
      task.checkScript
        ? 'The check script awaits user approval: until approved, runs are skipped without running the script or opening a session. Tell the user they can review, test and approve it below this tool call or in project Automations.'
        : null,
      'The user can edit, pause, run or delete it in project Scheduling. Runs appear under the task rather than in the session list.',
    ]
    return lines.filter(Boolean).join('\n')
  }

  // --- create_automation ---------------------------------------------------------

  /** Webhook automation with `schedule_task` limits: no creation by automation-born sessions and project caps. Return signing secrets because agents need them to configure caller webhooks (`gh api repos/…/hooks`). */
  async createAutomation(
    requester: Requester,
    project: ProjectRow,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (!this.encryptionKey) throw new Refusal('Automations are unavailable on this server.')
    if (requester.scheduleId) {
      throw new Refusal(
        'Refused: this session was started by an automation or scheduled task. Automations creating more automations would multiply unattended; create a card with create_card instead.',
      )
    }
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) throw new Refusal('The `name` parameter is required.')
    if (name.length > MAX_SCHEDULE_NAME_CHARS) throw new Refusal(`Name too long (maximum ${MAX_SCHEDULE_NAME_CHARS} characters).`)

    const template = payload.template === undefined || payload.template === null || payload.template === ''
      ? null
      : AUTOMATION_TEMPLATES.find((entry) => entry.id === payload.template)
    if (template === undefined) {
      throw new Refusal(`Unknown template “${String(payload.template)}”. Available values: ${AUTOMATION_TEMPLATES.map((entry) => entry.id).join(', ')}.`)
    }
    const prompt = typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt.trim() : (template?.prompt.en ?? '')
    if (!prompt) throw new Refusal('Without a template, `prompt` is required: instructions with `{{payload.…}}` placeholders.')
    if (prompt.length > MAX_SCHEDULE_PROMPT_CHARS) throw new Refusal(`Instructions too long (maximum ${MAX_SCHEDULE_PROMPT_CHARS} characters).`)

    const settings: Partial<WebhookSettings> = { ...template?.settings }
    if (payload.conditions !== undefined) {
      const parsed = automationConditionsSchema.safeParse({ mode: payload.match ?? 'all', rules: payload.conditions })
      if (!parsed.success) throw new Refusal(describeZod(parsed.error))
      settings.conditions = parsed.data
    }
    if (typeof payload.subject_path === 'string') settings.subjectPath = payload.subject_path.trim()
    if (payload.verification !== undefined) {
      const presets: Record<string, WebhookVerification> = {
        github: { kind: 'hmac', header: 'x-hub-signature-256', algorithm: 'sha256', prefix: 'sha256=' },
        gitlab: { kind: 'token', header: 'x-gitlab-token' },
        none: { kind: 'none' },
      }
      const chosen = presets[String(payload.verification)]
      if (!chosen) throw new Refusal('`verification` must be `github`, `gitlab` or `none`.')
      settings.verification = chosen
    }

    const [existing] = this.ctx.db
      .select({ total: count() })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.projectId, project.id))
      .all()
    if ((existing?.total ?? 0) >= MAX_AGENT_SCHEDULES_PER_PROJECT) {
      throw new Refusal(`Refused: this project already has ${MAX_AGENT_SCHEDULES_PER_PROJECT} automations and scheduled tasks.`)
    }

    const agent = this.configs.parseAgent(payload.agent, requester.agent)
    const config = await this.configs.launchConfig(agent, project, requester.userId, payload, requester.apiToken)
    const key = this.encryptionKey
    const { task, hook } = this.ctx.db.transaction(() => {
      const task = createScheduledTask(
        this.ctx.db,
        { projectId: project.id, userId: requester.userId, conversationId: requester.id || undefined },
        {
          name,
          agent,
          config,
          prompt,
          cadence: { kind: 'webhook' },
          overlapPolicy: 'wait',
          maxDurationMinutes: DEFAULT_SCHEDULE_DURATION_MINUTES,
          enabled: true,
        },
      )
      return { task, hook: createWebhook(this.ctx.db, key, task.id, settings, template?.id ?? null) }
    })
    const url = webhookUrl(this.ctx.config.server.publicUrl, hook.token)
    const verification = readSettings(hook).verification
    const secret = revealSecret(key, hook)

    return [
      `Automation “${task.name}” created (id ${task.id}), enabled.`,
      `Adresse : ${url}`,
      verification.kind === 'none'
        ? 'Verification: none; the URL alone is sufficient. Tell the user.'
        : `Signing secret: ${secret} (${verification.kind === 'hmac' ? `HMAC ${verification.algorithm} in header ${verification.header}` : `token in header ${verification.header}`}). Copy it only into the webhook configuration.`,
      'For GitHub: `gh api repos/OWNER/REPO/hooks -f name=web -F active=true -f "events[]=issues" -f config[url]=<url> -f config[content_type]=json -f config[secret]=<secret>` (adapt events to conditions).',
      `Each accepted call opens a new session (CLI ${agent}, model ${describeModel(config)}), one at a time, maximum ${DEFAULT_SCHEDULE_DURATION_MINUTES} min; exceeding ${readSettings(hook).maxRunsPerHour} launches per hour pauses it.`,
      'The user adjusts conditions, script and prompt in project Automations, which also shows received calls and their outcomes.',
    ].join('\n')
  }
}

/** Agent cadence: exactly one of `every_minutes`, `cron`, `at`. Flat parameters rather than discriminated objects match familiar `CronCreate` and reduce model mistakes. */
function parseAgentCadence(payload: Record<string, unknown>): ScheduleCadence {
  const given = ['every_minutes', 'cron', 'at'].filter(
    (key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== '',
  )
  if (given.length !== 1) {
    throw new Refusal(
      'Provide exactly one cadence: `every_minutes` (interval), `cron` (five-field pattern), or `at` (single ISO 8601 date and time).',
    )
  }

  let candidate: unknown
  if (given[0] === 'every_minutes') {
    candidate = { kind: 'interval', minutes: payload.every_minutes }
  } else if (given[0] === 'cron') {
    candidate = { kind: 'cron', expression: typeof payload.cron === 'string' ? payload.cron.trim() : payload.cron }
  } else {
    const at = typeof payload.at === 'string' ? Date.parse(payload.at) : Number.NaN
    if (Number.isNaN(at)) throw new Refusal('`at` must be an ISO 8601 date, e.g. 2026-10-12T09:00:00+02:00.')
    if (at <= Date.now()) throw new Refusal('`at` is in the past.')
    candidate = { kind: 'once', at }
  }

  const parsed = scheduleCadenceSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Refusal(
      given[0] === 'cron'
        ? `Invalid cron pattern “${String(payload.cron)}”: use five fields (minute hour day month weekday), in server time.`
        : '`every_minutes` must be a positive integer.',
    )
  }

  const cadence = parsed.data
  if (cadence.kind === 'interval' && cadence.minutes < MIN_AGENT_SCHEDULE_MINUTES) {
    throw new Refusal(`Interval too short: minimum ${MIN_AGENT_SCHEDULE_MINUTES} minutes.`)
  }
  if (cadence.kind === 'cron') {
    const [first, second] = new Cron(cadence.expression, { paused: true }).nextRuns(2)
    if (first && second && second.getTime() - first.getTime() < MIN_AGENT_SCHEDULE_MINUTES * 60_000) {
      throw new Refusal(`Pattern too frequent: minimum ${MIN_AGENT_SCHEDULE_MINUTES} minutes between runs.`)
    }
  }
  return cadence
}

function describeCadence(cadence: ScheduleCadence): string {
  if (cadence.kind === 'interval') return `every ${cadence.minutes} minutes`
  if (cadence.kind === 'cron') return `cron pattern \`${cadence.expression}\``
  if (cadence.kind === 'webhook') return 'on each webhook call'
  return `once, at ${new Date(cadence.at).toISOString()}`
}
