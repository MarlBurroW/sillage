import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  apiIdempotency,
  apiTaskOptions,
  conversations,
  projects,
  type ApiTokenRow,
  type ConversationRow,
} from '@sillage/db'
import {
  DEFAULT_REPLY_DEADLINE_SEC,
  V1_NOISY_EVENT_TYPES,
  createTaskBodySchema,
  taskEventsQuerySchema,
  taskListQuerySchema,
  taskMessageBodySchema,
  taskReplyBodySchema,
  taskSteerBodySchema,
  type TaskEventsPageDto,
} from '@sillage/protocol'
import type { WebhookService } from '../../webhooks/service.js'
import type { AgentRegistry } from '../../agents/registry.js'
import { createConversation } from '../../conversations/create.js'
import type { EventLog } from '../../events/event-log.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import { readUserSettings } from '../../settings/user-settings.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { requireScope } from '../require-user.js'
import {
  allowedProjectIds,
  assertWorktreeBelongs,
  loadProjectForToken,
  loadTaskForToken,
  publicBaseUrl,
} from './access.js'
import { assertTokenExecution } from './execution-policy.js'
import { resolveTaskConfig } from './config.js'
import { taskToDto, taskToSummaryDto } from './task-view.js'

const NOISY = new Set<string>(V1_NOISY_EVENT_TYPES)

export function registerTaskRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  log: EventLog,
  sessions: SessionManager,
  registry: AgentRegistry,
  webhooks: WebhookService,
): void {
  const view = (request: FastifyRequest, row: ConversationRow) =>
    taskToDto(log, row, publicBaseUrl(ctx, request))

  /**
   * Lists apply both token filters, never just one.
   *
   * Conversation ownership alone is insufficient: a project-restricted token
   * shared with a third party would otherwise reveal titles and last messages
   * from all its owner's conversations under `scope=user`, even though
   * `GET /tasks/:id` rejects them. The list must enforce the same restrictions.
   */
  const listTasks = (
    request: FastifyRequest,
    token: ApiTokenRow,
    filter: {
      userId: string
      projectId?: string
      status?: ConversationRow['status']
      scope: 'token' | 'user'
    },
  ) => {
    const allowed = allowedProjectIds(token)

    const rows = ctx.db
      .select({ conversation: conversations })
      .from(conversations)
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .where(
        and(
          eq(conversations.userId, filter.userId),
          isNull(conversations.archivedAt),
          isNull(projects.archivedAt),
          allowed.length > 0 ? inArray(projects.id, allowed) : undefined,
          filter.scope === 'token' ? eq(conversations.createdByTokenId, token.id) : undefined,
          filter.projectId ? eq(conversations.projectId, filter.projectId) : undefined,
          filter.status ? eq(conversations.status, filter.status) : undefined,
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .all()

    return rows.map((row) => taskToSummaryDto(row.conversation, publicBaseUrl(ctx, request)))
  }

  /**
   * Starts a task.
   *
   * A prompt suffices: CLI, model and effort come from the token, project or
   * CLI defaults, in that order.
   */
  app.post('/api/v1/projects/:id/tasks', async (request, reply) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id } = request.params as { id: string }
    const body = createTaskBodySchema.parse(request.body)
    const project = loadProjectForToken(ctx, token, user.id, id)

    /**
     * Idempotency cannot rely on the five-minute in-memory send deduplication:
     * a later retry would create another conversation. The key is optional but
     * repeated keys return the original result.
     *
     * Reserve before creation, which launches a CLI and takes seconds; otherwise
     * simultaneous calls would both assume they were first. The losing caller
     * reads the reservation instead of opening another conversation.
     */
    const header = request.headers['idempotency-key']
    const idempotencyKey = typeof header === 'string' && header.length > 0 ? header : null

    if (idempotencyKey) {
      const claimed = ctx.db
        .insert(apiIdempotency)
        .values({
          tokenId: token.id,
          key: idempotencyKey,
          conversationId: null,
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .run()

      if (claimed.changes === 0) {
        const seen = ctx.db
          .select({ conversationId: apiIdempotency.conversationId })
          .from(apiIdempotency)
          .where(and(eq(apiIdempotency.tokenId, token.id), eq(apiIdempotency.key, idempotencyKey)))
          .get()

        const existing = seen?.conversationId
          ? ctx.db.select().from(conversations).where(eq(conversations.id, seen.conversationId)).get()
          : undefined

        if (existing) return reply.status(200).send(view(request, existing))
        throw conflict(
          'idempotency_in_flight',
          'A task with this Idempotency-Key is still being created.',
        )
      }
    }

    let row
    try {
      if (body.worktreeId) assertWorktreeBelongs(ctx, id, body.worktreeId)
      const { agent, config } = await resolveTaskConfig(
        registry,
        token,
        project,
        body,
        readUserSettings(ctx.db, user.id).agentDefaults,
        (config) => sessions.modelsFor(user.id, config),
      )

      const clientMessageId = randomUUID()
      row = await createConversation(ctx.db, sessions, {
        projectId: id,
        userId: user.id,
        agent,
        config,
        worktreeId: body.worktreeId,
        // The board belongs to the interface: the machine API does not attach cards.
        cardId: null,
        title: body.title,
        origin: { tokenId: token.id, label: token.label },
        firstMessage: {
          clientMessageId,
          text: body.prompt,
          attachments: [],
          mentions: [],
          skills: [],
        },
      })

      // After creation: options reference the conversation, and failed creation
      // must not leave an orphaned row.
      ctx.db
        .insert(apiTaskOptions)
        .values({
          conversationId: row.id,
          webhookUrl: body.webhookUrl ?? null,
          replyDeadlineSec: body.replyDeadlineSec ?? DEFAULT_REPLY_DEADLINE_SEC,
        })
        .run()
      webhooks.trackMessage(row.id, clientMessageId)
    } catch (err) {
      // Remove reservations that created nothing, otherwise the same key stays stuck
      // in 'creating' and the caller can never retry.
      if (idempotencyKey) {
        ctx.db
          .delete(apiIdempotency)
          .where(and(eq(apiIdempotency.tokenId, token.id), eq(apiIdempotency.key, idempotencyKey)))
          .run()
      }
      throw err
    }

    if (idempotencyKey) {
      ctx.db
        .update(apiIdempotency)
        .set({ conversationId: row.id })
        .where(and(eq(apiIdempotency.tokenId, token.id), eq(apiIdempotency.key, idempotencyKey)))
        .run()
    }

    return reply.status(201).send(view(request, row))
  })

  app.get('/api/v1/projects/:id/tasks', async (request) => {
    const { token, user } = requireScope(request, 'tasks:read')
    const { id } = request.params as { id: string }
    loadProjectForToken(ctx, token, user.id, id)
    const query = taskListQuerySchema.parse(request.query)

    return listTasks(request, token, {
      userId: user.id,
      projectId: id,
      status: query.status,
      scope: query.scope,
    })
  })

  /** Cross-project view of everything launched by the caller. */
  app.get('/api/v1/tasks', async (request) => {
    const { token, user } = requireScope(request, 'tasks:read')
    const query = taskListQuerySchema.parse(request.query)
    if (query.projectId) loadProjectForToken(ctx, token, user.id, query.projectId)

    return listTasks(request, token, {
      userId: user.id,
      projectId: query.projectId,
      status: query.status,
      scope: query.scope,
    })
  })

  app.get('/api/v1/tasks/:id', async (request) => {
    const { token, user } = requireScope(request, 'tasks:read')
    const { id } = request.params as { id: string }
    return view(request, loadTaskForToken(ctx, token, user.id, id))
  })

  /**
   * Journal for callers needing details omitted from the folded view.
   *
   * Deltas are excluded by default: token-level entries would overwhelm polling
   * clients without adding information beyond the tool call producing them.
   */
  app.get('/api/v1/tasks/:id/events', async (request) => {
    const { token, user } = requireScope(request, 'tasks:read')
    const { id } = request.params as { id: string }
    const query = taskEventsQuerySchema.parse(request.query)
    loadTaskForToken(ctx, token, user.id, id)

    const wanted = query.types
      ? new Set(query.types.split(',').map((type) => type.trim()).filter(Boolean))
      : null

    // Read a page before filtering it: advance over everything read, otherwise a
    // verbose conversation would leave callers looping on an unchanged `nextAfter`.
    // Request one extra entry to determine whether more remain; a full page alone
    // would incorrectly promise another page whenever the total is an exact multiple.
    const page = log.read(id, query.after, query.limit + 1)
    const hasMore = page.length > query.limit
    const read = hasMore ? page.slice(0, query.limit) : page
    const kept = read.filter((entry) =>
      wanted ? wanted.has(entry.event.type) : !NOISY.has(entry.event.type),
    )

    const payload: TaskEventsPageDto = {
      taskId: id,
      events: kept.map((entry) => ({ seq: entry.seq, ts: entry.ts, event: entry.event })),
      nextAfter: read.at(-1)?.seq ?? query.after,
      hasMore,
    }
    return payload
  })

  /** Restarts a task or resumes it after stopping, restoring the CLI context. */
  app.post('/api/v1/tasks/:id/messages', async (request, reply) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id } = request.params as { id: string }
    const body = taskMessageBodySchema.parse(request.body)
    const target = loadTaskForToken(ctx, token, user.id, id)
    assertTokenExecution(token, JSON.parse(target.config))

    const clientMessageId = randomUUID()
    await sessions.sendMessage(id, clientMessageId, body.prompt, [], [])
    // Return this to the caller AND retain it for correlation: the next turn's
    // `task.completed` webhook carries the same identifier.
    webhooks.trackMessage(id, clientMessageId)
    return reply.status(202).send({ accepted: true, clientMessageId })
  })

  /**
   * Steers the current turn.
   *
   * Steering only exists during a turn, and machine callers can lose the race:
   * they read `running`, send, and the turn has just ended. `onMissedTurn: queue`
   * then falls back to an ordinary message so the text is not lost.
   */
  app.post('/api/v1/tasks/:id/steer', async (request, reply) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id } = request.params as { id: string }
    const body = taskSteerBodySchema.parse(request.body)
    const target = loadTaskForToken(ctx, token, user.id, id)
    assertTokenExecution(token, JSON.parse(target.config))

    const clientMessageId = randomUUID()
    const steered = await sessions.steer(id, clientMessageId, body.prompt, [], [])
    if (steered) {
      webhooks.trackMessage(id, clientMessageId)
      return reply.status(202).send({ accepted: true, applied: 'steer', clientMessageId })
    }

    if (body.onMissedTurn === 'fail') {
      throw badRequest(
        'steer_unavailable',
        'No turn in progress to steer, or this CLI does not support it.',
      )
    }

    await sessions.sendMessage(id, clientMessageId, body.prompt, [], [])
    webhooks.trackMessage(id, clientMessageId)
    return reply.status(202).send({ accepted: true, applied: 'message', clientMessageId })
  })

  /**
   * Stops the current turn. A simple message resumes the task: the CLI restarts
   * its native session with the existing context.
   */
  app.post('/api/v1/tasks/:id/interrupt', async (request, reply) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id } = request.params as { id: string }
    loadTaskForToken(ctx, token, user.id, id)

    await sessions.interrupt(id)
    // Emit nothing when the author is the original token: it already knows.
    webhooks.taskStopped(id, { kind: 'token', id: token.id, label: token.label })
    return reply.status(202).send({ accepted: true })
  })

  /**
   * Answers a request, using one route for all four types.
   *
   * This is v1's main usability gain: machine clients need not choose among four
   * REST paths. The body declares the expected type; mismatches are rejected
   * rather than interpreted. A `permission` response must never answer a request
   * that has become a question.
   */
  app.post('/api/v1/tasks/:id/replies/:requestId', async (request) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id, requestId } = request.params as { id: string; requestId: string }
    const body = taskReplyBodySchema.parse(request.body)
    const target = loadTaskForToken(ctx, token, user.id, id)
    assertTokenExecution(token, JSON.parse(target.config))

    const pending = log.openPrompts(id).find((prompt) => prompt.requestId === requestId)
    if (!pending) {
      throw notFound('reply_request_not_found', 'No open request with this id on this task.')
    }
    if (pending.kind !== body.kind) {
      throw badRequest('reply_kind_mismatch', 'This request is a {kind}, not a {sent}.', {
        kind: pending.kind,
        sent: body.kind,
      })
    }

    // Use the user ID, as an interface click would: `permission_requests` references
    // `users.id`, and tokens borrow their owner's identity rather than create another.
    // The task origin marker already records that an agent is driving it.
    const decidedBy = user.id
    let resolved: boolean
    switch (body.kind) {
      case 'permission':
        resolved = sessions.resolvePermission(id, requestId, {
          decision: body.decision,
          scope: body.scope,
          decidedBy,
        })
        break
      case 'question':
        resolved = await sessions.answerQuestion(id, requestId, {
          status: body.status,
          answers: body.answers,
          decidedBy,
        })
        break
      case 'plan':
        resolved = sessions.reviewPlan(id, requestId, {
          decision: body.decision,
          followUpMode: body.followUpMode,
          decidedBy,
        })
        break
      case 'elicitation':
        resolved = sessions.resolveElicitation(id, requestId, {
          action: body.action,
          content: body.content,
          decidedBy,
        })
        break
    }

    if (!resolved) {
      // The journal still says open but the runner has died: use the same response
      // as the interface routes.
      throw badRequest('reply_expired', 'This request has expired, the session has ended.')
    }
    return { ok: true }
  })
}
