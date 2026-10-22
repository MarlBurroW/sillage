import { and, count, eq, gt, inArray } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  automationDeliveries,
  automationWebhooks,
  projects,
  scheduledTasks,
  type AutomationDeliveryRow,
  type AutomationWebhookRow,
  type ScheduledTaskRow,
} from '@sillage/db'
import type { AutomationEvent, DeliveryReason, DeliveryVerdict, WebhookSettings } from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import type { PushService } from '../push/push-service.js'
import type { TaskScheduler } from '../scheduler/task-scheduler.js'
import { launchRefusal } from '../sessions/agent-requests.js'
import {
  buildEvent,
  decide,
  eventOf,
  normalizeHeaders,
  readSettings,
  recordDelivery,
  revealSecret,
  setDeliveryOutcome,
  verifyCaller,
} from './webhooks.js'

const HOUR_MS = 60 * 60 * 1000

export interface ReceiveResult {
  status: number
  body: { delivery?: string; verdict: DeliveryVerdict | 'not_found'; reason?: DeliveryReason | null }
}

/** Receives webhook calls and decides their outcome in order: signature, replay, pause, conditions and script, launch chain, circuit breaker, available capacity. Launches nothing directly: accepted calls become `queued` and wake the scheduler to run them on its sweep. GitHub abandons calls after ten seconds, while opening CLI sessions takes longer. Safeguards after conditions are outside script control: scripts always returning 'launch' trip the circuit breaker rather than sustain loops. */
export class AutomationReceiver {
  private logger: FastifyBaseLogger | null = null

  constructor(
    private readonly ctx: AppContext,
    /** Encryption key for signature secrets, shared with routes. */
    readonly key: Buffer,
    private readonly tasks: TaskScheduler,
    private readonly push: PushService,
  ) {}

  setLogger(logger: FastifyBaseLogger): void {
    this.logger = logger
  }

  async receive(
    token: string,
    rawHeaders: Record<string, string | string[] | undefined>,
    query: Record<string, string>,
    raw: Buffer,
  ): Promise<ReceiveResult> {
    const hook = this.ctx.db.select().from(automationWebhooks).where(eq(automationWebhooks.token, token)).get()
    const task = hook
      ? this.ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, hook.taskId)).get()
      : undefined
    if (!hook || !task) return { status: 404, body: { verdict: 'not_found' } }

    const settings = readSettings(hook)
    const headers = normalizeHeaders(rawHeaders)
    const event = buildEvent(headers, query, raw.toString('utf8'))
    const deliveryId = settings.deliveryHeader ? (headers[settings.deliveryHeader] ?? null) : null

    if (!verifyCaller(settings.verification, revealSecret(this.key, hook), headers, raw)) {
      const row = this.record(task, settings, event, deliveryId, 'unauthorized', { code: 'unauthorized' })
      return { status: 401, body: { delivery: row.id, verdict: 'unauthorized' } }
    }
    return this.process(task, hook, settings, event, deliveryId)
  }

  /** Replays a journal call as newly received, except for signature and replay checks. */
  async replay(task: ScheduledTaskRow, hook: AutomationWebhookRow, delivery: AutomationDeliveryRow): Promise<ReceiveResult> {
    return this.process(task, hook, readSettings(hook), eventOf(delivery), null)
  }

  private async process(
    task: ScheduledTaskRow,
    hook: AutomationWebhookRow,
    settings: WebhookSettings,
    event: AutomationEvent,
    deliveryId: string | null,
  ): Promise<ReceiveResult> {
    const respond = (row: AutomationDeliveryRow, status = 200): ReceiveResult => ({
      status,
      body: { delivery: row.id, verdict: row.verdict as DeliveryVerdict, reason: row.reason ? (JSON.parse(row.reason) as DeliveryReason) : null },
    })

    // Caller retry (GitHub retries unanswered requests): an already-accepted delivery
    // ID requires no further action.
    if (deliveryId) {
      const seen = this.ctx.db
        .select({ id: automationDeliveries.id })
        .from(automationDeliveries)
        .where(and(
          eq(automationDeliveries.taskId, task.id),
          eq(automationDeliveries.deliveryId, deliveryId),
          inArray(automationDeliveries.verdict, ['queued', 'launched', 'coalesced', 'launch_failed']),
        ))
        .get()
      if (seen) return respond(this.record(task, settings, event, deliveryId, 'duplicate', { code: 'duplicate' }))
    }

    const project = this.ctx.db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, task.projectId)).get()
    if (!task.enabled || project?.archivedAt) {
      const reason: DeliveryReason = { code: hook.trippedAt ? 'tripped' : project?.archivedAt ? 'archived' : 'paused' }
      return respond(this.record(task, settings, event, deliveryId, 'disabled', reason))
    }

    const decision = await decide(this.ctx.db, settings, event)
    const extras = { subject: decision.subject, vars: decision.vars, origin: decision.originConversationId }
    if (decision.verdict !== 'launch') {
      return respond(this.record(task, settings, event, deliveryId, decision.verdict, decision.reason, extras))
    }

    // Calls marked by a session count as launches by that session:
    // `start_session` depth and rate limits apply.
    if (decision.originConversationId) {
      const refusal = launchRefusal(this.ctx.db, decision.originConversationId)
      if (refusal) return respond(this.record(task, settings, event, deliveryId, 'chain_refused', refusal.reason, extras))
    }

    const [recent] = this.ctx.db
      .select({ total: count() })
      .from(automationDeliveries)
      .where(and(
        eq(automationDeliveries.taskId, task.id),
        inArray(automationDeliveries.verdict, ['queued', 'launched']),
        gt(automationDeliveries.receivedAt, Date.now() - HOUR_MS),
      ))
      .all()
    if ((recent?.total ?? 0) >= settings.maxRunsPerHour) {
      this.trip(task, hook, settings.maxRunsPerHour)
      return respond(this.record(
        task, settings, event, deliveryId, 'circuit_open',
        { code: 'circuit_open', params: { max: settings.maxRunsPerHour } },
        extras,
      ))
    }

    if (this.tasks.isBusy(task.id) && task.overlapPolicy === 'skip') {
      return respond(this.record(task, settings, event, deliveryId, 'busy', { code: 'busy' }, extras))
    }

    // Two pending calls on the same subject: retain only the newest, which describes
    // the issue or PR's current state.
    if (decision.subject) {
      const waiting = this.ctx.db
        .select({ id: automationDeliveries.id })
        .from(automationDeliveries)
        .where(and(
          eq(automationDeliveries.taskId, task.id),
          eq(automationDeliveries.verdict, 'queued'),
          eq(automationDeliveries.subject, decision.subject),
        ))
        .all()
      for (const row of waiting) {
        setDeliveryOutcome(this.ctx.db, row.id, { verdict: 'coalesced', reason: { code: 'coalesced' } })
      }
    }

    const row = this.record(task, settings, event, deliveryId, 'queued', null, extras)
    this.tasks.kick()
    return respond(row, 202)
  }

  private record(
    task: ScheduledTaskRow,
    settings: WebhookSettings,
    event: AutomationEvent,
    deliveryId: string | null,
    verdict: DeliveryVerdict,
    reason: DeliveryReason | null,
    extras: { subject?: string | null; vars?: Record<string, unknown>; origin?: string | null } = {},
  ): AutomationDeliveryRow {
    return recordDelivery(this.ctx.db, {
      taskId: task.id,
      event,
      verification: settings.verification,
      deliveryId,
      verdict,
      reason,
      subject: extras.subject,
      vars: extras.vars,
      originConversationId: extras.origin,
    })
  }

  /** Pauses automation and notifies its author. Resuming requires human action: self-resetting circuit breakers would let loops restart. */
  private trip(task: ScheduledTaskRow, hook: AutomationWebhookRow, max: number): void {
    const now = Date.now()
    this.ctx.db.update(automationWebhooks).set({ trippedAt: now }).where(eq(automationWebhooks.taskId, hook.taskId)).run()
    this.ctx.db.update(scheduledTasks).set({ enabled: false, updatedAt: now }).where(eq(scheduledTasks.id, task.id)).run()
    this.logger?.warn({ task: task.id }, 'disjoncteur d’automatisation déclenché')
    void this.push
      .notify(task.userId, {
        title: `Automatisation en pause : ${task.name}`,
        body: `Plus de ${max} lancements en une heure. Vérifie qu'elle ne se relance pas en boucle, puis réactive-la.`,
        url: `/p/${task.projectId}/schedules`,
        tag: `automation-${task.id}`,
      })
      .catch((err: unknown) => this.logger?.warn({ err }, 'notification du disjoncteur en échec'))
  }
}
