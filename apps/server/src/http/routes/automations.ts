import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { publicUrlOf } from '../../settings/app-settings.js'
import { automationDeliveries, projects, scheduledTasks, type ScheduledTaskRow } from '@sillage/db'
import {
  replayWebhookBodySchema,
  summarizeEvent,
  testWebhookBodySchema,
  updateWebhookSettingsBodySchema,
  webhookCurlBodySchema,
  renderTemplate,
  type AutomationDeliveryDto,
  type WebhookTestResult,
} from '@sillage/protocol'
import { buildWebhookPrompt } from '../../automations/prompt.js'
import type { AutomationReceiver } from '../../automations/receiver.js'
import {
  buildEvent,
  decide,
  deliveryDetailToDto,
  deliveryToDto,
  eventOf,
  loadWebhook,
  normalizeHeaders,
  readSettings,
  revealSecret,
  webhookUrl,
  rotateWebhook,
  updateWebhook,
  webhookToDto,
} from '../../automations/webhooks.js'
import { launchRefusal } from '../../sessions/agent-requests.js'
import type { AppContext } from '../context.js'
import { forbidden, notFound } from '../errors.js'
import { createHmac } from 'node:crypto'
import { requireUser } from '../require-user.js'

/** Public address prefix, exempt from session authentication. */
export const HOOKS_PREFIX = '/api/hooks/'

/** Automation webhooks: the public receiving endpoint and interface reads and settings. Same permissions as scheduled tasks: project viewers can read; creators or project owners can configure and see the secret. */
export function registerAutomationRoutes(app: FastifyInstance, ctx: AppContext, receiver: AutomationReceiver): void {
  // Read on every call: configuration may be missing at registration time.
  const publicUrl = () => publicUrlOf(ctx.db, ctx.config)

  const loadProject = (projectId: string, userId: string) => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project || (project.ownerId !== userId && project.visibility !== 'shared')) {
      throw notFound('project_not_found', 'Project not found.')
    }
    return project
  }

  const loadTask = (taskId: string, userId: string, write: boolean): ScheduledTaskRow => {
    const task = ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId)).get()
    if (!task) throw notFound('schedule_not_found', 'Scheduled task not found.')
    const project = loadProject(task.projectId, userId)
    if (write && task.userId !== userId && project.ownerId !== userId) {
      throw forbidden('schedule_write_forbidden', 'Only the task creator or the project owner can change it.')
    }
    return task
  }

  const loadHook = (taskId: string) => {
    const hook = loadWebhook(ctx.db, taskId)
    if (!hook) throw notFound('automation_not_webhook', 'This task has no webhook.')
    return hook
  }

  const loadDelivery = (taskId: string, deliveryId: string) => {
    const row = ctx.db
      .select()
      .from(automationDeliveries)
      .where(and(eq(automationDeliveries.id, deliveryId), eq(automationDeliveries.taskId, taskId)))
      .get()
    if (!row) throw notFound('delivery_not_found', 'This call is not in the log anymore.')
    return row
  }

  /** Raw body of any content type: signatures are checked byte for byte, and callers may send JSON, forms or text. Encapsulated so this parser applies only here. */
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))
    scope.post(`${HOOKS_PREFIX}:token`, async (request, reply) => {
      const { token } = request.params as { token: string }
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
      const result = await receiver.receive(token, request.headers, request.query as Record<string, string>, raw)
      return reply.status(result.status).send(result.body)
    })
  })

  app.get('/api/schedules/:id/deliveries', async (request): Promise<AutomationDeliveryDto[]> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadTask(id, user.id, false)
    return ctx.db
      .select()
      .from(automationDeliveries)
      .where(eq(automationDeliveries.taskId, id))
      .orderBy(desc(automationDeliveries.receivedAt))
      .limit(100)
      .all()
      .map(deliveryToDto)
  })

  app.get('/api/schedules/:id/deliveries/:deliveryId', async (request) => {
    const user = requireUser(request)
    const { id, deliveryId } = request.params as { id: string; deliveryId: string }
    loadTask(id, user.id, false)
    return deliveryDetailToDto(loadDelivery(id, deliveryId))
  })

  app.patch('/api/schedules/:id/webhook', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadTask(id, user.id, true)
    const patch = updateWebhookSettingsBodySchema.parse(request.body)
    return webhookToDto(updateWebhook(ctx.db, loadHook(id), patch), publicUrl())
  })

  app.get('/api/schedules/:id/webhook/secret', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadTask(id, user.id, true)
    return { secret: revealSecret(receiver.key, loadHook(id)) }
  })

  app.post('/api/schedules/:id/webhook/rotate', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadTask(id, user.id, true)
    const hook = rotateWebhook(ctx.db, receiver.key, loadHook(id))
    return { webhook: webhookToDto(hook, publicUrl()), secret: revealSecret(receiver.key, hook) }
  })

  /** Tests saved or edited settings against a journal entry or test-bench input: verdict, individual conditions, script and the message the session would receive. Nothing is launched or written. */
  app.post('/api/schedules/:id/webhook/test', async (request): Promise<WebhookTestResult> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const task = loadTask(id, user.id, false)
    const body = testWebhookBodySchema.parse(request.body)
    const settings = { ...readSettings(loadHook(id)), ...body.settings }
    const stored = body.deliveryId ? loadDelivery(id, body.deliveryId) : null
    const event = stored ? eventOf(stored) : buildEvent(normalizeHeaders(body.call!.headers), {}, body.call!.body)
    const deliveryId = stored?.deliveryId ?? (settings.deliveryHeader ? (event.headers[settings.deliveryHeader] ?? null) : null)
    const decision = await decide(ctx.db, settings, event)
    const chain = decision.verdict === 'launch' && decision.originConversationId
      ? launchRefusal(ctx.db, decision.originConversationId)
      : null
    const template = body.prompt ?? task.prompt
    return {
      verdict: decision.verdict,
      conditions: decision.conditions,
      script: {
        ran: decision.script !== null,
        error: decision.script?.error ?? null,
        result: decision.script?.raw ?? null,
        durationMs: decision.script?.durationMs ?? 0,
        logs: decision.script?.logs ?? [],
      },
      subject: decision.subject,
      vars: decision.vars,
      prompt: renderTemplate(
        template,
        { ...event, vars: decision.vars, subject: decision.subject ?? '', date: '', delivery_id: deliveryId ?? '' },
        { keepMissing: true },
      ),
      // The full message including its header is what the agent will read. No session
      // ID exists yet, so mark its placeholder.
      message: buildWebhookPrompt({
        task: { name: task.name, prompt: template, maxDurationMinutes: task.maxDurationMinutes },
        delivery: {
          receivedAt: stored?.receivedAt ?? Date.now(),
          subject: decision.subject,
          summary: summarizeEvent(event),
          deliveryId,
          vars: Object.keys(decision.vars).length > 0 ? JSON.stringify(decision.vars) : null,
        },
        event,
        conversationId: '<session>',
        replay: false,
      }),
      reason: chain?.reason ?? decision.reason,
      originConversationId: decision.originConversationId,
    }
  })

  /** Already-signed curl command for sending this call for real: exercises the complete HTTP path without manually calculating HMAC. Sign here because browsers do not always have `crypto.subtle` (HTTP pages outside localhost). */
  app.post('/api/schedules/:id/webhook/curl', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadTask(id, user.id, true)
    const { headers, body, origin } = webhookCurlBodySchema.parse(request.body)
    const hook = loadHook(id)
    const settings = readSettings(hook)
    const secret = revealSecret(receiver.key, hook)
    const url = webhookUrl(publicUrl() || origin || '', hook.token)
    const all: Record<string, string> = { 'content-type': 'application/json', ...headers }
    const verification = settings.verification
    if (verification.kind === 'token') all[verification.header] = secret
    if (verification.kind === 'hmac') {
      all[verification.header] = `${verification.prefix}${createHmac(verification.algorithm, secret).update(body).digest('hex')}`
    }
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    const lines = [
      `curl -sS -X POST ${quote(url)}`,
      ...Object.entries(all).map(([name, value]) => `  -H ${quote(`${name}: ${value}`)}`),
      `  --data-binary ${quote(body)}`,
    ]
    return { command: lines.join(' \\\n') }
  })

  /** Replays a journal call as if newly received, applying every safeguard. */
  app.post('/api/schedules/:id/webhook/replay', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const task = loadTask(id, user.id, true)
    const { deliveryId } = replayWebhookBodySchema.parse(request.body)
    const result = await receiver.replay(task, loadHook(id), loadDelivery(id, deliveryId))
    return reply.status(result.status).send(result.body)
  })
}
