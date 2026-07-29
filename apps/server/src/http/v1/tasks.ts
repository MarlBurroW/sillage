import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  apiIdempotency,
  conversations,
  projects,
  type ApiTokenRow,
  type ConversationRow,
} from '@sillage/db'
import {
  V1_NOISY_EVENT_TYPES,
  createTaskBodySchema,
  taskEventsQuerySchema,
  taskListQuerySchema,
  taskMessageBodySchema,
  taskSteerBodySchema,
  type TaskEventsPageDto,
} from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import { createConversation } from '../../conversations/create.js'
import type { EventLog } from '../../events/event-log.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict } from '../errors.js'
import { requireScope } from '../require-user.js'
import {
  allowedProjectIds,
  assertWorktreeBelongs,
  loadProjectForToken,
  loadTaskForToken,
  publicBaseUrl,
} from './access.js'
import { resolveTaskConfig } from './config.js'
import { taskToDto, taskToSummaryDto } from './task-view.js'

const NOISY = new Set<string>(V1_NOISY_EVENT_TYPES)

export function registerTaskRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  log: EventLog,
  sessions: SessionManager,
  registry: AgentRegistry,
): void {
  const view = (request: FastifyRequest, row: ConversationRow) =>
    taskToDto(log, row, publicBaseUrl(ctx, request))

  /**
   * La liste applique les deux filtres du jeton, jamais un seul.
   *
   * L'appartenance du fil ne suffit pas : un jeton restreint à un projet et confié à un
   * tiers rendrait sinon, en `scope=user`, le titre et le dernier message de toutes les
   * conversations de son propriétaire, alors que `GET /tasks/:id` les refuse. C'est la
   * liste qui aurait tort.
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
   * Lance une tâche.
   *
   * Un prompt suffit : le CLI, le modèle et l'effort viennent du jeton, du projet ou
   * des défauts du CLI, dans cet ordre.
   */
  app.post('/api/v1/projects/:id/tasks', async (request, reply) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id } = request.params as { id: string }
    const body = createTaskBodySchema.parse(request.body)
    const project = loadProjectForToken(ctx, token, user.id, id)

    /**
     * L'idempotence ne peut pas s'appuyer sur la déduplication des envois, qui vit en
     * mémoire sur cinq minutes : un agent qui réessaie plus tard ouvrirait une seconde
     * conversation. La clé est facultative, mais rejouée telle quelle si elle revient.
     *
     * Elle se réserve avant la création, et non après : la création lance un CLI, donc
     * dure des secondes, et deux appels partis en même temps se seraient tous deux crus
     * seuls. Le perdant de la course lit la réservation au lieu d'ouvrir un second fil.
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
      const { agent, config } = await resolveTaskConfig(registry, token, project, body)

      row = await createConversation(ctx.db, sessions, {
        projectId: id,
        userId: user.id,
        agent,
        config,
        worktreeId: body.worktreeId,
        title: body.title,
        origin: { tokenId: token.id, label: token.label },
        firstMessage: {
          clientMessageId: randomUUID(),
          text: body.prompt,
          attachments: [],
          mentions: [],
        },
      })
    } catch (err) {
      // Une réservation qui n'a rien créé doit disparaître, sinon la même clé resterait
      // bloquée en « création en cours » et l'appelant ne pourrait plus réessayer.
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

  /** Vue transverse : ce que l'appelant a lancé, tous projets confondus. */
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
   * Le journal, pour qui veut le détail que la vue repliée ne donne pas.
   *
   * Les deltas sont exclus par défaut : ils arrivent au token et noieraient un client
   * qui interroge, sans rien dire de plus que l'appel d'outil qui les produit.
   */
  app.get('/api/v1/tasks/:id/events', async (request) => {
    const { token, user } = requireScope(request, 'tasks:read')
    const { id } = request.params as { id: string }
    const query = taskEventsQuerySchema.parse(request.query)
    loadTaskForToken(ctx, token, user.id, id)

    const wanted = query.types
      ? new Set(query.types.split(',').map((type) => type.trim()).filter(Boolean))
      : null

    // Une page est lue puis filtrée : le curseur avance sur ce qui a été lu, sinon un
    // fil bavard ferait boucler l'appelant sur un `nextAfter` immobile. Une entrée de
    // plus est demandée pour savoir s'il en reste, plutôt que de le déduire d'une page
    // pleine, ce qui annoncerait une suite inexistante à chaque fin ronde.
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

  /** Relance une tâche, ou la reprend après un arrêt : le contexte du CLI est retrouvé. */
  app.post('/api/v1/tasks/:id/messages', async (request, reply) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id } = request.params as { id: string }
    const body = taskMessageBodySchema.parse(request.body)
    loadTaskForToken(ctx, token, user.id, id)

    await sessions.sendMessage(id, randomUUID(), body.prompt, [], [])
    return reply.status(202).send({ accepted: true })
  })

  /**
   * Infléchit le tour en cours.
   *
   * Une inflexion n'existe que pendant un tour, et un appelant machine perd la course :
   * il lit `running`, envoie, et le tour vient de finir. `onMissedTurn: queue` bascule
   * alors en message ordinaire, pour que le texte ne se perde pas.
   */
  app.post('/api/v1/tasks/:id/steer', async (request, reply) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id } = request.params as { id: string }
    const body = taskSteerBodySchema.parse(request.body)
    loadTaskForToken(ctx, token, user.id, id)

    const steered = await sessions.steer(id, randomUUID(), body.prompt, [], [])
    if (steered) return reply.status(202).send({ accepted: true, applied: 'steer' })

    if (body.onMissedTurn === 'fail') {
      throw badRequest(
        'steer_unavailable',
        'No turn in progress to steer, or this CLI does not support it.',
      )
    }

    await sessions.sendMessage(id, randomUUID(), body.prompt, [], [])
    return reply.status(202).send({ accepted: true, applied: 'message' })
  })

  /**
   * Arrête le tour en cours. La tâche se reprend par un simple message : le CLI
   * redémarre sur sa session native, avec son contexte.
   */
  app.post('/api/v1/tasks/:id/interrupt', async (request, reply) => {
    const { token, user } = requireScope(request, 'tasks:write')
    const { id } = request.params as { id: string }
    loadTaskForToken(ctx, token, user.id, id)

    await sessions.interrupt(id)
    return reply.status(202).send({ accepted: true })
  })
}
