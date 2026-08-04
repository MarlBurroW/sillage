import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, min, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversationReads, conversations, projects, type ConversationRow } from '@sillage/db'
import {
  createConversationBodySchema,
  editDiffQuerySchema,
  elicitationAnswerBodySchema,
  forkConversationBodySchema,
  markReadBodySchema,
  permissionDecisionBodySchema,
  planDecisionBodySchema,
  questionAnswerBodySchema,
  parseAgentConfig,
  reorderConversationsBodySchema,
  sendMessageBodySchema,
  steerBodySchema,
  updateConversationBodySchema,
  type ConversationDto,
  type ConversationStatus,
  type EditDiffDto,
  type JournalPageDto,
  type WorkingDiffDto,
} from '@sillage/protocol'
import { ForkError, type AgentRegistry } from '../../agents/registry.js'
import type { OutgoingAttachment } from '../../agents/types.js'
import { isInlineImage, type AttachmentStore } from '../../attachments/store.js'
import { createConversation } from '../../conversations/create.js'
import type { WebhookService } from '../../webhooks/service.js'
import { assertWorktreeBelongs } from '../v1/access.js'
import { readGitStatus, readHeadCommit, readWorkingDiff } from '../../git.js'
import type { EventLog } from '../../events/event-log.js'
import { dropConversation } from '../../search/search-index.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

const PAGE_SIZE = 500

/**
 * `lastReadSeq` est passé plutôt que relu ici : les routes de liste le ramènent en une
 * jointure, et une lecture par ligne rendrait la sidebar quadratique.
 */
export function conversationToDto(
  row: ConversationRow,
  userId: string,
  lastReadSeq: number,
): ConversationDto {
  return {
    id: row.id,
    projectId: row.projectId,
    worktreeId: row.worktreeId,
    userId: row.userId,
    title: row.title,
    titleSetByUser: row.titleSetByUser,
    agent: row.agent,
    forkedFromId: row.forkedFromId,
    config: parseAgentConfig(row.config),
    status: row.status,
    lastSeq: row.lastSeq,
    lastReadSeq,
    costUsd: row.costUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    pinned: row.pinned,
    position: row.position,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isOwner: row.userId === userId,
    origin: row.originLabel
      ? { tokenId: row.createdByTokenId, label: row.originLabel }
      : null,
  }
}

export function registerConversationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  log: EventLog,
  sessions: SessionManager,
  registry: AgentRegistry,
  attachments: AttachmentStore,
  webhooks: WebhookService,
): void {
  /**
   * Résout les pièces jointes à envoyer, dans l'ordre choisi par le client.
   *
   * Un identifiant inconnu, appartenant à quelqu'un d'autre ou déjà envoyé fait
   * échouer l'ensemble : envoyer un message amputé d'un de ses fichiers serait pire
   * qu'un refus, l'utilisateur croirait l'agent en possession de tout.
   */
  const resolveAttachments = (userId: string, ids: string[]): OutgoingAttachment[] => {
    if (ids.length === 0) return []

    const byId = new Map(attachments.listClaimable(userId, ids).map((row) => [row.id, row]))
    return ids.map((id) => {
      const row = byId.get(id)
      if (!row) {
        throw badRequest(
          'attachment_unavailable',
          'Attachment {id} is unavailable or has already been sent.',
          { id },
        )
      }
      return {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        path: row.storagePath,
        inlineImage: isInlineImage(row.mimeType),
      }
    })
  }
  /** Curseur de lecture d'un compte. 0 quand il n'a jamais ouvert le fil. */
  const readCursor = (conversationId: string, userId: string): number => {
    const row = ctx.db
      .select({ lastReadSeq: conversationReads.lastReadSeq })
      .from(conversationReads)
      .where(
        and(
          eq(conversationReads.conversationId, conversationId),
          eq(conversationReads.userId, userId),
        ),
      )
      .get()
    return row?.lastReadSeq ?? 0
  }

  /** Lecture : propriétaire du projet ou projet partagé. Écriture : propriétaire du fil. */
  const loadReadable = async (conversationId: string, userId: string) => {
    const row = ctx.db
      .select({ conversation: conversations, ownerId: projects.ownerId, visibility: projects.visibility })
      .from(conversations)
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .where(eq(conversations.id, conversationId))
      .get()

    if (!row) throw notFound('conversation_not_found', 'Conversation not found.')
    if (row.ownerId !== userId && row.visibility !== 'shared') {
      throw notFound('conversation_not_found', 'Conversation not found.')
    }
    return row.conversation
  }

  const loadWritable = async (conversationId: string, userId: string) => {
    const conversation = await loadReadable(conversationId, userId)
    if (conversation.userId !== userId) {
      throw forbidden('conversation_write_forbidden', 'Only the conversation owner can write to it.')
    }
    return conversation
  }

  /**
   * Toutes les conversations visibles, tous projets confondus. La sidebar les affiche
   * groupées sous leur projet : une requête plutôt qu'une par projet.
   */
  app.get('/api/conversations', async (request) => {
    const user = requireUser(request)

    const rows = ctx.db
      .select({ conversation: conversations, lastReadSeq: conversationReads.lastReadSeq })
      .from(conversations)
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .leftJoin(
        conversationReads,
        and(
          eq(conversationReads.conversationId, conversations.id),
          eq(conversationReads.userId, user.id),
        ),
      )
      // Les archivées comprises, la sidebar les rangeant elle-même dans sa section
      // repliée. Deux requêtes séparées coûteraient un aller-retour à chaque dépliage,
      // et un désarchivage ne pourrait plus se voir sans recharger les deux.
      .where(or(eq(projects.ownerId, user.id), eq(projects.visibility, 'shared')))
      .orderBy(desc(conversations.pinned), asc(conversations.position))
      .all()

    return rows.map((row) => conversationToDto(row.conversation, user.id, row.lastReadSeq ?? 0))
  })

  app.get('/api/projects/:id/conversations', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const includeArchived = (request.query as { archived?: string }).archived === '1'

    const project = ctx.db.select().from(projects).where(eq(projects.id, id)).get()
    if (!project) throw notFound('project_not_found', 'Project not found.')
    if (project.ownerId !== user.id && project.visibility !== 'shared') {
      throw notFound('project_not_found', 'Project not found.')
    }

    const rows = ctx.db
      .select({ conversation: conversations, lastReadSeq: conversationReads.lastReadSeq })
      .from(conversations)
      .leftJoin(
        conversationReads,
        and(
          eq(conversationReads.conversationId, conversations.id),
          eq(conversationReads.userId, user.id),
        ),
      )
      .where(
        includeArchived
          ? eq(conversations.projectId, id)
          : and(eq(conversations.projectId, id), isNull(conversations.archivedAt)),
      )
      .orderBy(desc(conversations.pinned), asc(conversations.position))
      .all()

    return rows.map((row) => conversationToDto(row.conversation, user.id, row.lastReadSeq ?? 0))
  })

  app.post('/api/projects/:id/conversations', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = createConversationBodySchema.parse(request.body)

    if (body.config.agent !== body.agent) {
      throw badRequest('config_agent_mismatch', 'The configuration does not match the selected CLI.')
    }

    const project = ctx.db.select().from(projects).where(eq(projects.id, id)).get()
    if (!project) throw notFound('project_not_found', 'Project not found.')
    if (project.ownerId !== user.id && project.visibility !== 'shared') {
      throw notFound('project_not_found', 'Project not found.')
    }

    if (body.worktreeId) assertWorktreeBelongs(ctx, id, body.worktreeId)

    // Les `CLI_DEFAULT` sont remplacés par ce que le CLI annonce, avant d'écrire en
    // base : la conversation garde ensuite une configuration explicite et stable.
    const config = await registry.adapter(body.agent).resolveDefaults(body.config)

    const firstMessage = body.firstMessage
    const row = await createConversation(ctx.db, sessions, {
      projectId: id,
      userId: user.id,
      agent: body.agent,
      config,
      worktreeId: body.worktreeId,
      title: body.title,
      origin: null,
      firstMessage: firstMessage && {
        clientMessageId: firstMessage.clientMessageId,
        text: firstMessage.text,
        attachments: resolveAttachments(user.id, firstMessage.attachmentIds),
        mentions: firstMessage.mentions,
      },
    })

    // Rattachées seulement après un envoi réussi : si le CLI refuse, la conversation
    // a été supprimée et les fichiers restent réutilisables pour une nouvelle tentative.
    if (firstMessage) attachments.claim(firstMessage.attachmentIds, row.id)

    // Curseur à zéro : le client marque la conversation lue en s'y installant, comme
    // pour n'importe quelle autre. La devancer ici mentirait sur ce qui est en base.
    return reply.status(201).send(conversationToDto(row, user.id, 0))
  })

  /**
   * Ordre manuel des conversations d'un projet. Le client envoie la liste complète
   * telle qu'elle doit s'afficher : réécrire les positions en bloc évite les trous et
   * les égalités qu'un déplacement unitaire finirait par produire.
   */
  app.post('/api/projects/:id/conversations/order', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = reorderConversationsBodySchema.parse(request.body)

    const project = ctx.db.select().from(projects).where(eq(projects.id, id)).get()
    if (!project) throw notFound('project_not_found', 'Project not found.')
    if (project.ownerId !== user.id && project.visibility !== 'shared') {
      throw notFound('project_not_found', 'Project not found.')
    }

    const known = new Set(
      ctx.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.projectId, id))
        .all()
        .map((row) => row.id),
    )
    // Un identifiant étranger au projet déplacerait une conversation d'ailleurs :
    // on refuse l'ensemble plutôt que d'appliquer un ordre partiel.
    const intruder = body.ids.find((conversationId) => !known.has(conversationId))
    if (intruder) {
      throw badRequest(
        'conversation_not_in_project',
        'Conversation {id} does not belong to this project.',
        { id: intruder },
      )
    }

    ctx.db.transaction((tx) => {
      body.ids.forEach((conversationId, index) => {
        tx.update(conversations)
          .set({ position: index })
          .where(eq(conversations.id, conversationId))
          .run()
      })
    })

    return { ok: true }
  })

  /**
   * Branche une conversation à un point du fil.
   *
   * Lecture suffisante sur la source : brancher une conversation partagée est une
   * lecture, et la branche appartient à celui qui la crée. L'ordre des opérations
   * compte : la session est forkée d'abord, parce que c'est la seule étape qui peut
   * échouer pour une raison extérieure, et rien ne doit rester en base si elle échoue.
   */
  app.post('/api/conversations/:id/fork', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = forkConversationBodySchema.parse(request.body)
    const source = await loadReadable(id, user.id)

    if (body.throughSeq > source.lastSeq) {
      throw badRequest('fork_point_unknown', 'This cut point is beyond the end of the thread.')
    }

    let agentSessionId: string
    try {
      agentSessionId = await sessions.forkSession(id, body.throughSeq)
    } catch (err) {
      if (err instanceof ForkError) throw badRequest('fork_failed', err.message)
      throw err
    }

    const [lowest] = ctx.db
      .select({ min: min(conversations.position) })
      .from(conversations)
      .where(eq(conversations.projectId, source.projectId))
      .all()

    const now = Date.now()
    const row: ConversationRow = {
      ...source,
      id: randomUUID(),
      userId: user.id,
      title: body.title ?? `${source.title} (branche)`,
      titleSetByUser: body.title !== undefined,
      agentSessionId,
      forkedFromId: source.id,
      // La branche est ouverte depuis l'interface, par une personne : hériter du
      // marqueur d'origine de la source lui attribuerait un jeton qui n'y est pour rien.
      createdByTokenId: null,
      originLabel: null,
      status: 'idle',
      // Le journal est recopié juste après, qui posera le vrai compteur.
      lastSeq: 0,
      pinned: false,
      position: (lowest?.min ?? 0) - 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    ctx.db.insert(conversations).values(row).run()

    // Sans cette copie, la branche s'afficherait vide alors que l'agent, lui, se
    // souvient de tout l'historique conservé (invariant I2).
    const copied = log.copyThrough(id, row.id, body.throughSeq)

    return reply.status(201).send(conversationToDto({ ...row, lastSeq: copied }, user.id, 0))
  })

  app.get('/api/conversations/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const conversation = await loadReadable(id, user.id)
    return conversationToDto(conversation, user.id, readCursor(id, user.id))
  })

  /**
   * Avance le curseur de lecture. Ouvert à tout lecteur, y compris sur un fil qu'il ne
   * peut pas écrire : savoir ce qu'on a lu n'est pas une modification de la conversation.
   */
  app.post('/api/conversations/:id/read', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = markReadBodySchema.parse(request.body)
    await loadReadable(id, user.id)

    const now = Date.now()
    ctx.db
      .insert(conversationReads)
      .values({ conversationId: id, userId: user.id, lastReadSeq: body.seq, updatedAt: now })
      .onConflictDoUpdate({
        target: [conversationReads.conversationId, conversationReads.userId],
        // Le `max` est porté par la base et non par une lecture préalable : deux onglets
        // qui marquent en même temps ne peuvent alors pas se faire reculer l'un l'autre,
        // quel que soit l'ordre d'arrivée.
        set: {
          lastReadSeq: sql`max(excluded.last_read_seq, ${conversationReads.lastReadSeq})`,
          updatedAt: now,
        },
      })
      .run()

    return { lastReadSeq: readCursor(id, user.id) }
  })

  app.get('/api/conversations/:id/events', async (request): Promise<JournalPageDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const after = Number((request.query as { after?: string }).after ?? 0)
    const conversation = await loadReadable(id, user.id)

    const entries = log.read(id, Number.isFinite(after) ? after : 0, PAGE_SIZE)
    return {
      entries: entries.map((entry) => ({ seq: entry.seq, ts: entry.ts, event: entry.event })),
      lastSeq: conversation.lastSeq,
    }
  })

  /**
   * Diff du répertoire de travail de la conversation, worktree compris. Calculé à la
   * demande plutôt que journalisé : c'est un état courant du disque, pas un événement.
   */
  app.get('/api/conversations/:id/diff', async (request): Promise<WorkingDiffDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadReadable(id, user.id)

    const cwd = sessions.workingDirectory(id)
    try {
      // Les trois lectures partent ensemble : elles lancent chacune un process git, et
      // les enchaîner triplerait le temps d'ouverture de l'onglet.
      const [diff, status, head] = await Promise.all([
        readWorkingDiff(cwd),
        readGitStatus(cwd),
        readHeadCommit(cwd),
      ])
      return {
        files: diff?.files ?? null,
        patch: diff?.patch ?? '',
        truncated: diff?.truncated ?? false,
        cwd,
        branch: status?.branch ?? null,
        head,
      }
    } catch (err) {
      throw badRequest('git_failed', err instanceof Error ? err.message : String(err))
    }
  })

  /**
   * Ce qu'un appel d'outil a fait d'un fichier, pour l'historique du panneau.
   *
   * Reconstitué depuis le payload natif conservé dans le journal (invariant I3 : la
   * lecture est faite par l'adaptateur du CLI concerné). Un tour passé n'a pas de
   * diff git à interroger, le disque ayant continué d'évoluer depuis.
   */
  app.get('/api/conversations/:id/edits/:toolCallId', async (request): Promise<EditDiffDto> => {
    const user = requireUser(request)
    const { id, toolCallId } = request.params as { id: string; toolCallId: string }
    const { path } = editDiffQuerySchema.parse(request.query)

    const conversation = await loadReadable(id, user.id)
    return registry.adapter(conversation.agent).describeEdit({
      log,
      conversationId: id,
      toolCallId,
      cwd: sessions.workingDirectory(id),
      path,
    })
  })

  app.patch('/api/conversations/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateConversationBodySchema.parse(request.body)
    const conversation = await loadWritable(id, user.id)

    const patch: Partial<ConversationRow> = {}
    if (body.title !== undefined) {
      patch.title = body.title.trim()
      patch.titleSetByUser = true
    }
    if (body.pinned !== undefined) patch.pinned = body.pinned
    if (body.archived !== undefined) patch.archivedAt = body.archived ? Date.now() : null

    if (body.config !== undefined) {
      if (body.config.agent !== conversation.agent) {
        throw badRequest('config_agent_immutable', 'The CLI of a conversation cannot change.')
      }
      patch.config = JSON.stringify(body.config)
    }

    if (Object.keys(patch).length > 0) {
      ctx.db.update(conversations).set(patch).where(eq(conversations.id, id)).run()
    }

    // Le SDK applique modèle, effort et mode de permission à chaud : la session garde
    // son contexte. Le repli par redémarrage est géré, et signalé, par le gestionnaire.
    if (body.config !== undefined) await sessions.reloadConfig(id)

    return { ok: true }
  })

  app.delete('/api/conversations/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadWritable(id, user.id)
    // Les fichiers d'abord : la cascade de la base n'efface que les lignes.
    await attachments.removeForConversations([id])
    // L'index de recherche est une table virtuelle : aucune cascade ne l'atteint.
    dropConversation(ctx.db, id)
    ctx.db.delete(conversations).where(eq(conversations.id, id)).run()
    return reply.status(204).send()
  })

  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = sendMessageBodySchema.parse(request.body)
    const conversation = await loadWritable(id, user.id)

    // Écrire dans un fil rangé le ressort de l'archive : sinon il repart au travail
    // tout en restant invisible, et son activité ne se signale nulle part.
    if (conversation.archivedAt !== null) {
      ctx.db.update(conversations).set({ archivedAt: null }).where(eq(conversations.id, id)).run()
    }

    const files = resolveAttachments(user.id, body.attachmentIds)
    await sessions.sendMessage(id, body.clientMessageId, body.text, files, body.mentions)
    attachments.claim(body.attachmentIds, id)

    return reply.status(202).send({ accepted: true })
  })

  /**
   * Infléchit le tour en cours.
   *
   * Distinct de `/messages`, qui met en file pendant un tour : les deux gestes ne
   * produisent pas le même résultat, et lequel s'applique doit rester le choix de
   * l'utilisateur. Un refus est donc rendu tel quel plutôt que replié sur la file.
   */
  app.post('/api/conversations/:id/steer', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = steerBodySchema.parse(request.body)
    await loadWritable(id, user.id)

    const files = resolveAttachments(user.id, body.attachmentIds)
    const steered = await sessions.steer(
      id,
      body.clientMessageId,
      body.text,
      files,
      body.mentions,
    )
    if (!steered) {
      throw badRequest(
        'steer_unavailable',
        'No turn in progress to steer, or this CLI does not support it.',
      )
    }
    attachments.claim(body.attachmentIds, id)

    return reply.status(202).send({ accepted: true })
  })

  /** Demande à l'agent de résumer la conversation pour libérer du contexte. */
  app.post('/api/conversations/:id/compact', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadWritable(id, user.id)

    if (!(await sessions.compact(id))) {
      throw badRequest('compact_unsupported', 'This CLI does not support compaction.')
    }
    return reply.status(202).send({ accepted: true })
  })

  app.post('/api/conversations/:id/interrupt', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadWritable(id, user.id)
    await sessions.interrupt(id)
    // Une tâche lancée par un jeton et arrêtée ici laisserait son appelant suspendu à
    // une complétion qui ne viendra jamais : le webhook `task.stopped` le lui dit.
    webhooks.taskStopped(id, { kind: 'user', id: user.id, label: user.displayName })
    return reply.status(204).send()
  })

  app.post('/api/conversations/:id/permissions/:requestId', async (request) => {
    const user = requireUser(request)
    const { id, requestId } = request.params as { id: string; requestId: string }
    const body = permissionDecisionBodySchema.parse(request.body)
    await loadWritable(id, user.id)

    if (!sessions.hasPendingPermission(id, requestId)) {
      throw notFound('permission_request_not_found', 'Permission request not found.')
    }

    const resolved = sessions.resolvePermission(id, requestId, {
      decision: body.decision,
      scope: body.scope,
      decidedBy: user.id,
    })
    if (!resolved) {
      // La session a pu s'arrêter entre l'affichage et le clic : le dire explicitement
      // plutôt que de laisser l'UI attendre une réponse qui ne viendra pas.
      throw badRequest('permission_expired', 'This request has expired, the session has ended.')
    }
    return { ok: true }
  })

  /**
   * Réponse à une question de l'agent. Contrairement aux permissions, l'état ne vit
   * que dans le runner : c'est le journal qui garde la trace, et une demande qui n'y
   * est plus en attente n'a plus personne pour l'écouter.
   */
  app.post('/api/conversations/:id/questions/:requestId', async (request) => {
    const user = requireUser(request)
    const { id, requestId } = request.params as { id: string; requestId: string }
    const body = questionAnswerBodySchema.parse(request.body)
    await loadWritable(id, user.id)

    const answered = sessions.answerQuestion(id, requestId, {
      status: body.status,
      answers: body.answers,
      decidedBy: user.id,
    })
    if (!answered) {
      throw badRequest('question_expired', 'This question is no longer awaiting an answer.')
    }
    return { ok: true }
  })

  /** Retire de la file un message qui n'est pas encore parti au CLI. */
  app.delete('/api/conversations/:id/queue/:queueId', async (request, reply) => {
    const user = requireUser(request)
    const { id, queueId } = request.params as { id: string; queueId: string }
    await loadWritable(id, user.id)

    if (!sessions.cancelQueued(id, queueId)) {
      throw badRequest('queue_entry_gone', 'This message has already been sent.')
    }
    return reply.status(204).send()
  })

  /**
   * Fait passer un message en attente dans le tour en cours.
   *
   * Le pendant de `DELETE` sur la même entrée : le message est déjà écrit et déjà en
   * file, ce geste ne fait que choisir quand l'agent le lit.
   */
  app.post('/api/conversations/:id/queue/:queueId/steer', async (request, reply) => {
    const user = requireUser(request)
    const { id, queueId } = request.params as { id: string; queueId: string }
    await loadWritable(id, user.id)

    const outcome = await sessions.steerQueued(id, queueId)
    if (outcome === 'gone') {
      throw badRequest('queue_entry_gone', 'This message has already been sent.')
    }
    if (outcome === 'unavailable') {
      throw badRequest(
        'steer_unavailable',
        'No turn in progress to steer, or this CLI does not support it.',
      )
    }

    return reply.status(202).send({ accepted: true })
  })

  app.post('/api/conversations/:id/elicitations/:requestId', async (request) => {
    const user = requireUser(request)
    const { id, requestId } = request.params as { id: string; requestId: string }
    const body = elicitationAnswerBodySchema.parse(request.body)
    await loadWritable(id, user.id)

    const resolved = sessions.resolveElicitation(id, requestId, {
      action: body.action,
      content: body.content,
      decidedBy: user.id,
    })
    if (!resolved) {
      throw badRequest('elicitation_expired', 'This request is no longer awaiting an answer.')
    }
    return { ok: true }
  })

  app.post('/api/conversations/:id/plans/:requestId', async (request) => {
    const user = requireUser(request)
    const { id, requestId } = request.params as { id: string; requestId: string }
    const body = planDecisionBodySchema.parse(request.body)
    await loadWritable(id, user.id)

    const reviewed = sessions.reviewPlan(id, requestId, {
      decision: body.decision,
      followUpMode: body.followUpMode,
      decidedBy: user.id,
    })
    if (!reviewed) {
      throw badRequest('plan_expired', 'This plan is no longer awaiting a decision.')
    }
    return { ok: true }
  })
}

/** Statut et avancement courants, pour l'instantané envoyé à l'abonnement WebSocket. */
export function readConversationState(
  ctx: AppContext,
  conversationId: string,
): { status: ConversationStatus; lastSeq: number } | null {
  return (
    ctx.db
      .select({ status: conversations.status, lastSeq: conversations.lastSeq })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get() ?? null
  )
}

/** Conversations visibles par un utilisateur, pour l'abonnement WebSocket. */
export function canReadConversation(ctx: AppContext, conversationId: string, userId: string): boolean {
  const row = ctx.db
    .select({ ownerId: projects.ownerId, visibility: projects.visibility })
    .from(conversations)
    .innerJoin(projects, eq(projects.id, conversations.projectId))
    .where(
      and(
        eq(conversations.id, conversationId),
        or(eq(projects.ownerId, userId), eq(projects.visibility, 'shared')),
      ),
    )
    .get()
  return row !== undefined
}
