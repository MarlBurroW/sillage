import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, isNull, min, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  cards,
  conversationFavorites,
  conversationHandoffs,
  conversationReads,
  conversations,
  projects,
  writeTransaction,
  type ConversationRow,
} from '@sillage/db'
import {
  createConversationBodySchema,
  editDiffQuerySchema,
  eventBodyRefSchema,
  elicitationAnswerBodySchema,
  forkConversationBodySchema,
  handoffConversationBodySchema,
  markReadBodySchema,
  permissionDecisionBodySchema,
  planDecisionBodySchema,
  questionAnswerBodySchema,
  parseAgentConfig,
  reorderConversationsBodySchema,
  sendMessageBodySchema,
  steerBodySchema,
  updateConversationBodySchema,
  type CardLinkDto,
  type ConversationDto,
  type ConversationMetrics,
  type ConversationStatus,
  type EditDiffDto,
  type HandoffDto,
  type JournalPageDto,
  type ToolOutputDto,
} from '@sillage/protocol'
import { ForkError, type AgentRegistry } from '../../agents/registry.js'
import type { OutgoingAttachment } from '../../agents/types.js'
import { isInlineImage, type AttachmentStore } from '../../attachments/store.js'
import { createConversation } from '../../conversations/create.js'
import {
  buildHandoff,
  clampHandoffTokens,
  HandoffError,
  readHandoffItems,
} from '../../conversations/handoff.js'
import { conversationMetrics } from '../../conversations/metrics.js'
import type { WebhookService } from '../../webhooks/service.js'
import { assertWorktreeBelongs } from '../v1/access.js'
import { advanceCardOnLaunch, assertCardInProject, readCardLink } from './cards.js'
import { coalesceDeltas } from '../../events/coalesce.js'
import type { EventLog } from '../../events/event-log.js'
import { dropConversation } from '../../search/search-index.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/** Replay page limits (`EventLog.readForReplay`). Every page costs a round trip and clients load sequentially; 500-event pages required 147 requests for the largest conversation. Byte limits bound database payloads and daemon memory; row limits bound the preceding listing. Keep the cap at 16 MB: the largest conversations replay below 96 MB in a constrained heap, whereas old 500-event pages exceeded 128 MB. Larger pages save a few round trips at the expense of memory also needed by active sessions. */
const PAGE_ROWS = 5000
const PAGE_BYTES = 16_000_000

/** Pass `lastReadSeq`, `card` and `favorite` instead of rereading: list routes fetch them in one join, while reading each row would make sidebar work quadratic. */
export function conversationToDto(
  row: ConversationRow,
  userId: string,
  lastReadSeq: number,
  card: CardLinkDto | null,
  favorite: boolean,
): ConversationDto {
  return {
    id: row.id,
    projectId: row.projectId,
    worktreeId: row.worktreeId,
    card,
    userId: row.userId,
    title: row.title,
    titleSetByUser: row.titleSetByUser,
    agent: row.agent,
    forkedFromId: row.forkedFromId,
    handoffFromId: row.handoffFromId,
    config: parseAgentConfig(row.config),
    status: row.status,
    lastSeq: row.lastSeq,
    lastNotableSeq: row.lastNotableSeq,
    lastReadSeq,
    costUsd: row.costUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    metrics: conversationMetrics(row),
    pinned: row.pinned,
    favorite,
    position: row.position,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isOwner: row.userId === userId,
    origin: row.originLabel
      ? { tokenId: row.createdByTokenId, label: row.originLabel }
      : null,
    scheduleId: row.scheduleId,
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
  /** Resolves outgoing attachments in client-selected order. Unknown IDs, other users' files and already-sent files reject the whole request: silently omitting files would be worse, since users would assume the agent received everything. */
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
  /** Account read cursor, zero before the thread was ever opened. */
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

  /** Whether this conversation is a favorite for this account. Individual reads only. */
  const isFavorite = (conversationId: string, userId: string): boolean =>
    ctx.db
      .select({ conversationId: conversationFavorites.conversationId })
      .from(conversationFavorites)
      .where(
        and(
          eq(conversationFavorites.conversationId, conversationId),
          eq(conversationFavorites.userId, userId),
        ),
      )
      .get() !== undefined

  /** Read: project owner or shared project. Write: conversation owner. */
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

  /** All visible conversations across projects. The sidebar groups them by project; one request replaces one per project. */
  app.get('/api/conversations', async (request) => {
    const user = requireUser(request)

    const rows = ctx.db
      .select({
        conversation: conversations,
        lastReadSeq: conversationReads.lastReadSeq,
        favoritedAt: conversationFavorites.createdAt,
        card: {
          id: cards.id,
          number: cards.number,
          title: cards.title,
          column: cards.column,
        },
      })
      .from(conversations)
      .leftJoin(cards, eq(cards.id, conversations.cardId))
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .leftJoin(
        conversationReads,
        and(
          eq(conversationReads.conversationId, conversations.id),
          eq(conversationReads.userId, user.id),
        ),
      )
      .leftJoin(
        conversationFavorites,
        and(
          eq(conversationFavorites.conversationId, conversations.id),
          eq(conversationFavorites.userId, user.id),
        ),
      )
      // Include archived conversations: the sidebar places them in its collapsed section.
      // Separate queries would add a round trip on every expansion and require reloading
      // both lists to see unarchiving.
      .where(or(eq(projects.ownerId, user.id), eq(projects.visibility, 'shared')))
      .orderBy(desc(conversations.pinned), asc(conversations.position))
      .all()

    return rows.map((row) =>
      conversationToDto(
        row.conversation,
        user.id,
        row.lastReadSeq ?? 0,
        row.card,
        row.favoritedAt !== null,
      ),
    )
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
      .select({
        conversation: conversations,
        lastReadSeq: conversationReads.lastReadSeq,
        favoritedAt: conversationFavorites.createdAt,
        card: {
          id: cards.id,
          number: cards.number,
          title: cards.title,
          column: cards.column,
        },
      })
      .from(conversations)
      .leftJoin(cards, eq(cards.id, conversations.cardId))
      .leftJoin(
        conversationReads,
        and(
          eq(conversationReads.conversationId, conversations.id),
          eq(conversationReads.userId, user.id),
        ),
      )
      .leftJoin(
        conversationFavorites,
        and(
          eq(conversationFavorites.conversationId, conversations.id),
          eq(conversationFavorites.userId, user.id),
        ),
      )
      .where(
        includeArchived
          ? eq(conversations.projectId, id)
          : and(eq(conversations.projectId, id), isNull(conversations.archivedAt)),
      )
      .orderBy(desc(conversations.pinned), asc(conversations.position))
      .all()

    return rows.map((row) =>
      conversationToDto(
        row.conversation,
        user.id,
        row.lastReadSeq ?? 0,
        row.card,
        row.favoritedAt !== null,
      ),
    )
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
    if (body.cardId) assertCardInProject(ctx, body.cardId, id)

    // Resolve `CLI_DEFAULT` from CLI announcements before database writes:
    // conversations then retain explicit, stable settings.
    const config = await registry.adapter(body.agent).resolveDefaults(body.config)

    const firstMessage = body.firstMessage
    const row = await createConversation(ctx.db, sessions, {
      projectId: id,
      userId: user.id,
      agent: body.agent,
      config,
      worktreeId: body.worktreeId,
      cardId: body.cardId,
      title: body.title,
      origin: null,
      firstMessage: firstMessage && {
        clientMessageId: firstMessage.clientMessageId,
        text: firstMessage.text,
        attachments: resolveAttachments(user.id, firstMessage.attachmentIds),
        mentions: firstMessage.mentions,
        skills: firstMessage.skills,
      },
    })

    // Attach only after successful sends: when the CLI rejects, the conversation is
    // deleted and files remain available for retry.
    if (firstMessage) attachments.claim(firstMessage.attachmentIds, row.id)

    // The board's sole automatic transition follows an action:
    // the send just succeeded, rather than merely detecting a running session.
    // Cards beyond `todo` never move backward.
    if (body.cardId) advanceCardOnLaunch(ctx, body.cardId)

    // Start the cursor at zero: clients mark conversations read when opening them,
    // as usual. Advancing it early would misrepresent database state.
    return reply
      .status(201)
      .send(conversationToDto(row, user.id, 0, readCardLink(ctx, body.cardId), false))
  })

  /** Manual conversation order within a project. Clients send the complete intended list; rewriting positions together avoids gaps and ties caused by individual moves. */
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
    // An ID outside the project would move another project's conversation:
    // reject the whole request rather than apply a partial order.
    const intruder = body.ids.find((conversationId) => !known.has(conversationId))
    if (intruder) {
      throw badRequest(
        'conversation_not_in_project',
        'Conversation {id} does not belong to this project.',
        { id: intruder },
      )
    }

    writeTransaction(ctx.db, (tx) => {
      body.ids.forEach((conversationId, index) => {
        tx.update(conversations)
          .set({ position: index })
          .where(eq(conversations.id, conversationId))
          .run()
      })
    })

    return { ok: true }
  })

  /** Forks a conversation at a point in its history. Source read access suffices: forking shared conversations is a read, and forks belong to their creator. Order matters: fork the native session first, the only step susceptible to external failures, so failure leaves nothing in the database. */
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
      titleSetByAgent: false,
      agentSessionId,
      forkedFromId: source.id,
      // People open forks through the interface: inheriting source origin markers
      // would incorrectly attribute them to an unrelated token.
      createdByTokenId: null,
      originLabel: null,
      scheduleId: null,
      status: 'idle',
      // The journal is copied immediately afterward and sets the real counter.
      lastSeq: 0,
      pinned: false,
      position: (lowest?.min ?? 0) - 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    ctx.db.insert(conversations).values(row).run()

    // Without this copy the fork would appear empty while the agent
    // remembers the entire retained history (invariant I2).
    const copied = log.copyThrough(id, row.id, body.throughSeq)
    // Copied turn markers must reference the same snapshots.
    await sessions.inheritCheckpoints(id, row.id)

    // Forks of continuations remain continuations: context arrives through the system
    // prompt on every start and would be lost without a dedicated row.
    const handoff = ctx.db
      .select()
      .from(conversationHandoffs)
      .where(eq(conversationHandoffs.conversationId, id))
      .get()
    if (handoff) {
      ctx.db.insert(conversationHandoffs).values({ ...handoff, conversationId: row.id }).run()
    }

    // Forks inherit card attachment: they explore the same work differently.
    return reply
      .status(201)
      .send(
        conversationToDto(
          { ...row, lastSeq: copied },
          user.id,
          0,
          readCardLink(ctx, row.cardId),
          false,
        ),
      )
  })

  /** Continues a conversation in another CLI. Read permission matches forks: continuing shared conversations is a read, and the new conversation belongs to its creator. Nothing is sent to the CLI here: save the selection with the conversation; the first new request starts a session with this context in its system prompt. */
  app.post('/api/conversations/:id/handoff', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = handoffConversationBodySchema.parse(request.body)
    const source = await loadReadable(id, user.id)

    if (body.config.agent !== body.agent) {
      throw badRequest('config_agent_mismatch', 'The configuration does not match the selected CLI.')
    }

    const budgetTokens = clampHandoffTokens(body.budgetTokens)
    let handoff
    try {
      handoff = buildHandoff(
        readHandoffItems(log, id),
        { id: source.id, title: source.title, agent: source.agent },
        body.agent,
        budgetTokens,
      )
    } catch (err) {
      if (err instanceof HandoffError) throw badRequest(err.code, err.message)
      throw err
    }

    const config = await registry.adapter(body.agent).resolveDefaults(body.config)
    const row = await createConversation(ctx.db, sessions, {
      projectId: source.projectId,
      userId: user.id,
      agent: body.agent,
      config,
      // Same tree and work: the same task continued with another
      // tool.
      worktreeId: source.worktreeId,
      cardId: source.cardId,
      title: body.title ?? source.title,
      origin: null,
      handoff: {
        fromConversationId: source.id,
        throughSeq: source.lastSeq,
        budgetTokens,
        text: handoff.text,
      },
    })

    return reply
      .status(201)
      .send(conversationToDto(row, user.id, 0, readCardLink(ctx, row.cardId), false))
  })

  /** Context received from the source, allowing users to see what the agent knows. */
  app.get('/api/conversations/:id/handoff', async (request): Promise<HandoffDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadReadable(id, user.id)
    const row = ctx.db
      .select()
      .from(conversationHandoffs)
      .where(eq(conversationHandoffs.conversationId, id))
      .get()
    if (!row) throw notFound('handoff_not_found', 'This conversation does not continue another one.')
    return {
      fromConversationId: row.fromConversationId,
      throughSeq: row.throughSeq,
      budgetTokens: row.budgetTokens,
      bytes: Buffer.byteLength(row.text),
      text: row.text,
      createdAt: row.createdAt,
    }
  })

  app.get('/api/conversations/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const conversation = await loadReadable(id, user.id)
    return conversationToDto(
      conversation,
      user.id,
      readCursor(id, user.id),
      readCardLink(ctx, conversation.cardId),
      isFavorite(id, user.id),
    )
  })

  /** Advances the read cursor. Any reader may do so, including without write access: tracking what one has read does not modify the conversation. */
  app.post('/api/conversations/:id/read', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = markReadBodySchema.parse(request.body)
    const conversation = await loadReadable(id, user.id)

    // Bound to this conversation's journal: clients following several conversations
    // will eventually send the previous one's `seq`; a cursor beyond existing entries
    // would prematurely mark all future output as read.
    const seq = Math.min(body.seq, conversation.lastSeq)
    const now = Date.now()
    ctx.db
      .insert(conversationReads)
      .values({ conversationId: id, userId: user.id, lastReadSeq: seq, updatedAt: now })
      .onConflictDoUpdate({
        target: [conversationReads.conversationId, conversationReads.userId],
        // Let the database calculate `max` rather than preread it: concurrent tabs cannot
        // move each other's cursor backward,
        // regardless of arrival order.
        set: {
          lastReadSeq: sql`max(excluded.last_read_seq, ${conversationReads.lastReadSeq})`,
          updatedAt: now,
        },
      })
      .run()

    return { lastReadSeq: readCursor(id, user.id) }
  })

  /** Adds or removes the caller's bookmark. Any reader may do so for the same reason as read cursors: bookmarking does not modify conversations. Both operations are idempotent, so clients need not know the previous state. */
  app.put('/api/conversations/:id/favorite', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadReadable(id, user.id)

    ctx.db
      .insert(conversationFavorites)
      .values({ conversationId: id, userId: user.id, createdAt: Date.now() })
      .onConflictDoNothing()
      .run()

    return { favorite: true }
  })

  app.delete('/api/conversations/:id/favorite', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadReadable(id, user.id)

    ctx.db
      .delete(conversationFavorites)
      .where(
        and(
          eq(conversationFavorites.conversationId, id),
          eq(conversationFavorites.userId, user.id),
        ),
      )
      .run()

    return { favorite: false }
  })

  app.get('/api/conversations/:id/thread', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadReadable(id, user.id)
    const query = request.query as { before?: string; after?: string }
    const before = query.before === undefined ? undefined : Number(query.before)
    const after = query.after === undefined ? undefined : Number(query.after)
    if ([before, after].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
      throw badRequest('invalid_thread_cursor', 'Invalid thread cursor.')
    }
    reply.header('cache-control', 'no-store')
    return log.thread.page(id, before, after)
  })

  app.get('/api/conversations/:id/events', async (request): Promise<JournalPageDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const asked = Number((request.query as { after?: string }).after ?? 0)
    const after = Number.isFinite(asked) ? asked : 0
    const conversation = await loadReadable(id, user.id)

    const bodies = (request.query as { bodies?: string }).bodies === '1'
    const page = log.readForReplay(id, after, { rows: PAGE_ROWS, bytes: PAGE_BYTES, bodies })
    return {
      entries: coalesceDeltas(page.entries).map((entry) => ({
        seq: entry.seq,
        ts: entry.ts,
        event: entry.event,
      })),
      nextAfter: page.nextAfter,
      lastSeq: conversation.lastSeq,
    }
  })

  // Body routes follow conversation visibility, including readers of shared projects.
  // No native/raw payload is exposed and no caller-supplied JSON path is evaluated.
  app.get('/api/conversations/:id/events/:seq/body/:field', async (request, reply) => {
    const user = requireUser(request)
    const { id, seq, field } = request.params as { id: string; seq: string; field: string }
    await loadReadable(id, user.id)
    const block = (request.query as { block?: string }).block
    const ref = eventBodyRefSchema.parse({ seq: Number(seq), field, ...(block === undefined ? {} : { block: Number(block) }) })
    const found = log.eventBody(id, ref.seq, ref.field, ref.block)
    if (!found) throw notFound('event_body_not_found', 'Content not found in this conversation.')
    return reply.header('cache-control', 'private, no-store').send(found)
  })

  app.get('/api/conversations/:id/events/:seq/images/:block', async (request, reply) => {
    const user = requireUser(request)
    const { id, seq, block } = request.params as { id: string; seq: string; block: string }
    await loadReadable(id, user.id)
    const ref = eventBodyRefSchema.parse({ seq: Number(seq), field: 'output', block: Number(block) })
    const url = log.eventImage(id, ref.seq, ref.block!)
    // Raster images only: active content (HTML/SVG) must never execute on our origin.
    const match = url && /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,/.exec(url)
    if (!match) throw notFound('event_body_not_found', 'Content not found in this conversation.')
    return reply.type(match[1]!).header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(url!.slice(match[0].length), 'base64'))
  })

  /** Full tool-call output. History replay returns previews of large outputs to avoid transferring megabytes nobody opens. Tool cards request full bodies here only when expanded. */
  app.get('/api/conversations/:id/tools/:toolCallId/output', async (request): Promise<ToolOutputDto> => {
    const user = requireUser(request)
    const { id, toolCallId } = request.params as { id: string; toolCallId: string }
    await loadReadable(id, user.id)

    const found = log.toolOutput(id, toolCallId)
    if (!found) throw notFound('tool_call_not_found', 'No such tool call in this conversation.')
    return { toolCallId, output: found.output }
  })

  /** File changes made by a tool call, for panel history. Reconstructed from the native payload retained in the journal (invariant I3: the relevant CLI adapter reads it). Past turns have no git diff to query because disk state has continued changing. */
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
      patch.titleSetByAgent = false
    }
    if (body.pinned !== undefined) patch.pinned = body.pinned
    if (body.archived !== undefined) patch.archivedAt = body.archived ? Date.now() : null
    // Archived conversations have no turns left to undo: remove their snapshots from git.
    if (body.archived === true && conversation.archivedAt === null) void sessions.dropCheckpoints(id)

    if (body.cardId !== undefined) {
      if (body.cardId) assertCardInProject(ctx, body.cardId, conversation.projectId)
      patch.cardId = body.cardId
      // Attaching later does not advance the card: the action says this session already
      // worked on this task, rather than launching anything.
    }

    if (body.config !== undefined) {
      if (body.config.agent !== conversation.agent) {
        throw badRequest('config_agent_immutable', 'The CLI of a conversation cannot change.')
      }
      patch.config = JSON.stringify(body.config)
    }

    if (Object.keys(patch).length > 0) {
      ctx.db.update(conversations).set(patch).where(eq(conversations.id, id)).run()
    }

    // The SDK applies model, effort and permission-mode changes live, preserving session
    // context. The manager handles and reports fallback restarts.
    if (body.config !== undefined) await sessions.reloadConfig(id)

    return { ok: true }
  })

  app.delete('/api/conversations/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadWritable(id, user.id)
    // Remove git snapshots first while the row still identifies the repository.
    await sessions.dropCheckpoints(id)
    // Remove files first: database cascades only delete rows.
    await attachments.removeForConversations([id])
    // The search index is a virtual table, unreachable by cascades.
    dropConversation(ctx.db, id)
    ctx.db.delete(conversations).where(eq(conversations.id, id)).run()
    return reply.status(204).send()
  })

  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = sendMessageBodySchema.parse(request.body)
    const conversation = await loadWritable(id, user.id)

    // Writing in archived conversations unarchives them; otherwise they would resume
    // work invisibly without activity being reported anywhere.
    if (conversation.archivedAt !== null) {
      ctx.db.update(conversations).set({ archivedAt: null }).where(eq(conversations.id, id)).run()
    }

    const files = resolveAttachments(user.id, body.attachmentIds)
    await sessions.sendMessage(id, body.clientMessageId, body.text, files, body.mentions, body.skills)
    attachments.claim(body.attachmentIds, id)

    return reply.status(202).send({ accepted: true })
  })

  /** Steers the current turn. Distinct from `/messages`, which queues during turns: these actions produce different results and users must choose which applies. Return rejections unchanged rather than falling back to the queue. */
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
      body.skills,
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

  /** Asks the agent to summarize the conversation to free context. */
  app.post('/api/conversations/:id/compact', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadWritable(id, user.id)

    if (!(await sessions.compact(id))) {
      throw badRequest('compact_unsupported', 'This CLI does not support compaction.')
    }
    return reply.status(202).send({ accepted: true })
  })

  /** Stops background work (command, workflow, watch) without affecting the turn. Completion is not in the response: it arrives through the journal's next `background.updated` event. */
  app.post('/api/conversations/:id/background/:taskId/stop', async (request, reply) => {
    const user = requireUser(request)
    const { id, taskId } = request.params as { id: string; taskId: string }
    await loadWritable(id, user.id)

    if (!(await sessions.stopBackgroundTask(id, taskId))) {
      throw badRequest(
        'background_stop_unavailable',
        'No running session holds this task, or this CLI cannot stop background work.',
      )
    }
    return reply.status(202).send({ accepted: true })
  })

  app.post('/api/conversations/:id/interrupt', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    await loadWritable(id, user.id)
    await sessions.interrupt(id)
    // Stopping token-created tasks here would leave callers waiting forever for
    // completion: `task.stopped` webhooks notify them.
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
      // Sessions may stop between rendering and clicking: say so explicitly rather
      // than leave the UI waiting for a response that will never arrive.
      throw badRequest('permission_expired', 'This request has expired, the session has ended.')
    }
    return { ok: true }
  })

  /** Answers an agent question. Unlike permissions, state lives only in the runner: the journal retains its trace, and requests no longer pending there have nobody listening. */
  app.post('/api/conversations/:id/questions/:requestId', async (request) => {
    const user = requireUser(request)
    const { id, requestId } = request.params as { id: string; requestId: string }
    const body = questionAnswerBodySchema.parse(request.body)
    await loadWritable(id, user.id)

    const answered = await sessions.answerQuestion(id, requestId, {
      status: body.status,
      answers: body.answers,
      decidedBy: user.id,
    })
    if (!answered) {
      throw badRequest('question_expired', 'This question is no longer awaiting an answer.')
    }
    return { ok: true }
  })

  /** Removes a queued message not yet sent to the CLI. */
  app.delete('/api/conversations/:id/queue/:queueId', async (request, reply) => {
    const user = requireUser(request)
    const { id, queueId } = request.params as { id: string; queueId: string }
    await loadWritable(id, user.id)

    if (!sessions.cancelQueued(id, queueId)) {
      throw badRequest('queue_entry_gone', 'This message has already been sent.')
    }
    return reply.status(204).send()
  })

  /** Sends a pending message into the current turn. Counterpart to `DELETE` on the same entry: the message is already written and queued; this only chooses when the agent reads it. */
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

/** Current status and progress for the WebSocket subscription snapshot. */
export function readConversationState(
  ctx: AppContext,
  conversationId: string,
): { status: ConversationStatus; lastNotableSeq: number; metrics: ConversationMetrics } | null {
  const row = ctx.db
    .select({
      status: conversations.status,
      lastNotableSeq: conversations.lastNotableSeq,
      turnCount: conversations.turnCount,
      journalBytes: conversations.journalBytes,
      contextUsedTokens: conversations.contextUsedTokens,
      contextMaxTokens: conversations.contextMaxTokens,
      model: conversations.model,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get()

  if (!row) return null
  return {
    status: row.status,
    lastNotableSeq: row.lastNotableSeq,
    metrics: conversationMetrics(row),
  }
}

/** Conversations visible to a user for WebSocket subscriptions. */
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
