import { basename } from 'node:path'
import { toAttachmentDto, type AttachmentStore } from '../../attachments/store.js'
import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, inArray, max, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { BoardSync } from '../../board/board-sync.js'
import {
  attachments,
  cardIssues,
  cardNotes,
  cardRefs,
  cards,
  conversations,
  projects,
  users,
  worktrees,
  writeTransaction,
  type CardRow,
  type Db,
  type ProjectRow,
} from '@sillage/db'
import {
  MAX_ATTACHMENT_BYTES,
  cardTagSettingsBodySchema,
  createCardBodySchema,
  createCardTagBodySchema,
  mergeCardTagBodySchema,
  updateCardTagBodySchema,
  createCardRelationBodySchema,
  createCardNoteBodySchema,
  parseCardReferences,
  reorderCardsBodySchema,
  updateCardBodySchema,
  type CardColumn,
  type CardConversationDto,
  type CardDto,
  type CardExternalDto,
  type CardLinkDto,
  type CardNoteDto,
} from '@sillage/protocol'
import type { AppContext } from '../context.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { linkCards, listCardRelations, unlinkCards } from '../../board/card-relations.js'
import { createTag, deleteTag, loadTag, mergeTags, readTagCatalog, setCardTags, tagsOfCards, updateTag } from '../../board/card-tags.js'

const MENTION_LIMIT = 20

/**
 * Board cards represent project work, separate from the conversations doing it.
 *
 * This file derives no state. A card's column is a deliberate position changed
 * only by an action; activity comes from attached conversations and merge status
 * from git, both outside this table. The sole automatic transition, `todo` to
 * `in_progress` on session launch, lives in conversation creation because sending
 * a message triggers it, not observing an active session.
 */
export function registerCardRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  store: AttachmentStore,
  /** Optional in tests that do not use it; the board remains disconnected. */
  board?: BoardSync,
): void {
  const loadProject = (projectId: string, userId: string): ProjectRow => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw notFound('project_not_found', 'Project not found.')
    if (project.ownerId !== userId && project.visibility !== 'shared') {
      throw notFound('project_not_found', 'Project not found.')
    }
    return project
  }

  const loadCard = (cardId: string, userId: string): { card: CardRow; project: ProjectRow } => {
    const card = ctx.db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!card) throw notFound('card_not_found', 'Card not found.')
    return { card, project: loadProject(card.projectId, userId) }
  }

  /**
   * Assembles project cards with a small number of queries.
   *
   * Read conversations and references in bulk rather than per card: otherwise
   * a thirty-card board would require ninety queries for one screen.
   */
  const buildDtos = (projectId: string, rows: CardRow[]): CardDto[] => {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)

    const attached = ctx.db
      .select({
        cardId: conversations.cardId,
        id: conversations.id,
        title: conversations.title,
        agent: conversations.agent,
        status: conversations.status,
        costUsd: conversations.costUsd,
        worktreeId: conversations.worktreeId,
        worktreeName: worktrees.name,
        archivedAt: conversations.archivedAt,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .leftJoin(worktrees, eq(worktrees.id, conversations.worktreeId))
      .where(inArray(conversations.cardId, ids))
      .orderBy(conversations.createdAt)
      .all()

    const sessions = new Map<string, CardConversationDto[]>()
    for (const row of attached) {
      if (!row.cardId) continue
      const list = sessions.get(row.cardId) ?? []
      list.push({
        id: row.id,
        title: row.title,
        agent: row.agent,
        status: row.status,
        costUsd: row.costUsd,
        worktreeId: row.worktreeId,
        worktreeName: row.worktreeName,
        archivedAt: row.archivedAt,
        createdAt: row.createdAt,
      })
      sessions.set(row.cardId, list)
    }

    const links = ctx.db
      .select({
        sourceId: cardRefs.sourceId,
        targetId: cardRefs.targetId,
        id: cards.id,
        number: cards.number,
        title: cards.title,
        column: cards.column,
      })
      .from(cardRefs)
      .innerJoin(cards, eq(cards.id, cardRefs.targetId))
      .where(inArray(cardRefs.sourceId, ids))
      .orderBy(cards.number)
      .all()

    const backlinks = ctx.db
      .select({
        sourceId: cardRefs.sourceId,
        targetId: cardRefs.targetId,
        id: cards.id,
        number: cards.number,
        title: cards.title,
        column: cards.column,
      })
      .from(cardRefs)
      .innerJoin(cards, eq(cards.id, cardRefs.sourceId))
      .where(inArray(cardRefs.targetId, ids))
      .orderBy(cards.number)
      .all()

    const group = (
      list: typeof links,
      key: (row: (typeof links)[number]) => string,
    ): Map<string, CardLinkDto[]> => {
      const grouped = new Map<string, CardLinkDto[]>()
      for (const row of list) {
        const bucket = grouped.get(key(row)) ?? []
        bucket.push({ id: row.id, number: row.number, title: row.title, column: row.column })
        grouped.set(key(row), bucket)
      }
      return grouped
    }

    const outgoing = group(links, (row) => row.sourceId)
    const incoming = group(backlinks, (row) => row.targetId)

    const notes = new Map(
      ctx.db
        .select({ cardId: cardNotes.cardId, total: count() })
        .from(cardNotes)
        .where(inArray(cardNotes.cardId, ids))
        .groupBy(cardNotes.cardId)
        .all()
        .map((row) => [row.cardId, row.total]),
    )

    const files = new Map(ctx.db.select({ cardId: attachments.cardId, total: count() })
      .from(attachments).where(inArray(attachments.cardId, ids)).groupBy(attachments.cardId)
      .all().map((row) => [row.cardId, row.total]))

    const issues = new Map(
      ctx.db
        .select()
        .from(cardIssues)
        .where(inArray(cardIssues.cardId, ids))
        .all()
        .map((row): [string, CardExternalDto] => [
          row.cardId,
          {
            provider: row.provider,
            number: row.number,
            url: row.url,
            author: row.author,
            labels: parseJsonList(row.labels),
            state: row.state,
            detached: row.detached,
          },
        ]),
    )

    const tags = tagsOfCards(ctx.db, ids)

    const authors = new Map(
      ctx.db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(
          inArray(
            users.id,
            rows.map((row) => row.createdBy),
          ),
        )
        .all()
        .map((row) => [row.id, row.displayName]),
    )

    return rows.map((row) => ({
      id: row.id,
      projectId,
      number: row.number,
      title: row.title,
      description: row.description,
      column: row.column,
      position: row.position,
      createdBy: row.createdBy,
      createdByName: authors.get(row.createdBy) ?? '',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // Cards created before the migration and never touched have none:
      // their creation time remains their arrival time.
      columnEnteredAt: row.columnEnteredAt ?? row.createdAt,
      conversations: sessions.get(row.id) ?? [],
      noteCount: notes.get(row.id) ?? 0,
      attachmentCount: files.get(row.id) ?? 0,
      references: outgoing.get(row.id) ?? [],
      referencedBy: incoming.get(row.id) ?? [],
      external: issues.get(row.id) ?? null,
      tags: tags.get(row.id) ?? [],
    }))
  }

  const readCard = (cardId: string, projectId: string): CardDto => {
    const row = ctx.db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!row) throw notFound('card_not_found', 'Card not found.')
    const [dto] = buildDtos(projectId, [row])
    if (!dto) throw notFound('card_not_found', 'Card not found.')
    return dto
  }

  app.get('/api/projects/:id/cards', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadProject(id, user.id)

    const rows = ctx.db
      .select()
      .from(cards)
      .where(eq(cards.projectId, id))
      .orderBy(cards.position, cards.number)
      .all()

    return buildDtos(id, rows)
  })

  /**
   * Referencable cards for composer `#` completion.
   *
   * Separate from the board list, which includes each card's sessions and
   * backlinks: unnecessary weight for a dropdown showing only numbers and titles.
   */
  app.get('/api/projects/:id/cards/mentions', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { q } = request.query as { q?: string }
    loadProject(id, user.id)

    const query = (q ?? '').trim()
    const rows = ctx.db
      .select({ id: cards.id, number: cards.number, title: cards.title, column: cards.column })
      .from(cards)
      .where(
        query.length === 0
          ? eq(cards.projectId, id)
          : and(
              eq(cards.projectId, id),
              // Match numbers by prefix and titles by substring: entering '1' means card 1,
              // not every card whose number contains a 1.
              sql`(${cards.title} LIKE ${`%${query}%`} COLLATE NOCASE
                   OR CAST(${cards.number} AS TEXT) LIKE ${`${query}%`})`,
            ),
      )
      .orderBy(cards.number)
      .limit(MENTION_LIMIT)
      .all()

    return { cards: rows }
  })

  app.post('/api/projects/:id/cards', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { github, tagIds, ...body } = createCardBodySchema.parse(request.body)
    loadProject(id, user.id)

    // Board settings decide unless explicitly overridden; disconnected boards are local.
    const link = board?.link(id)
    const row =
      board && link && (github ?? link.newCards === 'github')
        ? await board.createIssueCard(id, user.id, body)
        : createCard(ctx.db, id, user.id, body)
    if (tagIds.length > 0) setCardTags(ctx.db, row.id, id, tagIds)
    return reply.status(201).send(readCard(row.id, id))
  })

  app.get('/api/cards/:id/relations', async (request) => {
    const user = requireUser(request)
    const { card } = loadCard((request.params as { id: string }).id, user.id)
    return listCardRelations(ctx.db, card.projectId, card.number)
  })

  app.post('/api/cards/:id/relations', async (request) => {
    const user = requireUser(request)
    const { card } = loadCard((request.params as { id: string }).id, user.id)
    const body = createCardRelationBodySchema.parse(request.body)
    linkCards(ctx.db, card.projectId, card.number, body.target, body.kind)
    return listCardRelations(ctx.db, card.projectId, card.number)
  })

  app.delete('/api/cards/:id/relations', async (request, reply) => {
    const user = requireUser(request)
    const { card } = loadCard((request.params as { id: string }).id, user.id)
    const body = createCardRelationBodySchema.parse(request.body)
    unlinkCards(ctx.db, card.projectId, card.number, body.target, body.kind)
    return reply.status(204).send()
  })

  app.patch('/api/cards/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { tagIds, ...body } = updateCardBodySchema.parse(request.body)
    const { card } = loadCard(id, user.id)

    // Tags first: an unknown id rejects the whole request before anything else changes.
    if (tagIds !== undefined) setCardTags(ctx.db, card.id, card.projectId, tagIds)
    updateCard(ctx.db, card, body)
    // A tracked card changed: synchronization compares and sends updates to GitHub.
    board?.kick(card.projectId)

    return readCard(id, card.projectId)
  })

  app.delete('/api/cards/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { card, project } = loadCard(id, user.id)

    // Project owners manage their own board; authors can undo what they created.
    // Other trusted collaborators may edit cards but cannot delete them, because
    // deletion also removes backlinks created by others.
    if (project.ownerId !== user.id && card.createdBy !== user.id) {
      throw forbidden(
        'card_delete_forbidden',
        'Only the project owner or the card author can delete it.',
      )
    }

    // The issue stays on GitHub; it only leaves this board and does not return on
    // the next synchronization.
    const issue = board?.issueOf(id)
    if (board && issue && !issue.detached) board.hideIssue(card.projectId, issue.number)

    await store.removeForCards([id])
    writeTransaction(ctx.db, (tx) => {
      // Conversations outlive their cards and become ordinary conversations again:
      // they contain real work that organizing the board must not discard.
      tx.update(conversations).set({ cardId: null }).where(eq(conversations.cardId, id)).run()
      tx.delete(cards).where(eq(cards.id, id)).run()
    })

    return reply.status(204).send()
  })

  /** Publishes a local card as an issue, or reconnects a detached card to its issue. */
  app.post('/api/cards/:id/publish', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { card } = loadCard(id, user.id)
    if (!board) throw conflict('board_not_linked', 'This board is not linked to GitHub.')
    await board.publishCard(id)
    return readCard(id, card.projectId)
  })

  /** Makes the card local again; the issue remains on GitHub and is no longer tracked. */
  app.post('/api/cards/:id/unlink', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { card } = loadCard(id, user.id)
    if (!board) throw conflict('card_not_published', 'This card is not linked to an issue.')
    board.detachCard(id)
    return readCard(id, card.projectId)
  })

  app.get('/api/cards/:id/attachments', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadCard(id, user.id)
    return ctx.db.select().from(attachments).where(eq(attachments.cardId, id))
      .orderBy(attachments.createdAt).all().map(toAttachmentDto)
  })

  app.post('/api/cards/:id/attachments', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadCard(id, user.id)
    const file = await request.file({ limits: { fileSize: MAX_ATTACHMENT_BYTES } })
    if (!file) throw badRequest('no_file', 'No file received.')
    const content = await file.toBuffer().catch(() => null)
    if (!content || file.file.truncated) throw badRequest('file_too_large', 'File is too large.')
    if (!content.byteLength) throw badRequest('empty_file', 'File is empty.')
    // Check again after reading: the ticket may have disappeared during the request.
    loadCard(id, user.id)
    const dto = await store.save({ userId: user.id, cardId: id,
      filename: basename(file.filename).slice(0, 200) || 'fichier', content })
    return reply.status(201).send(dto)
  })

  app.delete('/api/cards/:id/attachments/:attachmentId', async (request, reply) => {
    const user = requireUser(request)
    const { id, attachmentId } = request.params as { id: string; attachmentId: string }
    loadCard(id, user.id)
    const file = store.get(attachmentId)
    if (!file || file.cardId !== id) throw notFound('attachment_not_found', 'Attachment not found.')
    await store.remove(attachmentId)
    return reply.status(204).send()
  })

  app.get('/api/cards/:id/notes', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadCard(id, user.id)
    return readNotes(ctx, id)
  })

  app.post('/api/cards/:id/notes', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = createCardNoteBodySchema.parse(request.body)
    const { card } = loadCard(id, user.id)

    const issue = body.publish ? board?.issueOf(id) : undefined
    if (body.publish && (!issue || issue.detached)) {
      throw conflict('card_not_published', 'This card is not linked to an issue.')
    }

    ctx.db
      .insert(cardNotes)
      .values({
        id: randomUUID(),
        cardId: id,
        conversationId: null,
        userId: user.id,
        body: body.body,
        createdAt: Date.now(),
        publication: issue ? 'pending' : null,
      })
      .run()
    if (issue) board?.kick(card.projectId)

    return reply.status(201).send(readNotes(ctx, id))
  })

  app.delete('/api/card-notes/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const note = ctx.db.select().from(cardNotes).where(eq(cardNotes.id, id)).get()
    if (!note) throw notFound('card_note_not_found', 'Note not found.')
    // Project read access suffices to delete: agent notes have no human author to
    // protect, and incorrect notes must be removable without their owner, which
    // may be a process that died days ago.
    loadCard(note.cardId, user.id)
    // Delete GitHub comments on GitHub: deleting only locally would make them return
    // on their next edit and leave the conversation misleading in the meantime.
    if (note.externalId !== null) {
      throw conflict('card_note_on_github', 'This note lives on GitHub; delete it there.')
    }

    ctx.db.delete(cardNotes).where(eq(cardNotes.id, id)).run()
    return reply.status(204).send()
  })

  /**
   * Tag catalog. Any reader of the board can manage it, like cards: tags organize shared work
   * and agents of every collaborator create them too.
   */
  app.get('/api/projects/:id/card-tags', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    loadProject(id, user.id)
    return readTagCatalog(ctx.db, id)
  })

  app.post('/api/projects/:id/card-tags', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = createCardTagBodySchema.parse(request.body)
    loadProject(id, user.id)
    createTag(ctx.db, id, body, { userId: user.id, conversationId: null })
    return reply.status(201).send(readTagCatalog(ctx.db, id))
  })

  /** Whether agents may create tags; only the owner decides, as for other project settings. */
  app.put('/api/projects/:id/card-tags/settings', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = cardTagSettingsBodySchema.parse(request.body)
    const project = loadProject(id, user.id)
    if (project.ownerId !== user.id) throw forbidden('project_edit_forbidden', 'Only the owner can modify this project.')
    ctx.db.update(projects).set({ agentCardTags: body.agentsCanCreate }).where(eq(projects.id, id)).run()
    return readTagCatalog(ctx.db, id)
  })

  app.patch('/api/card-tags/:id', async (request) => {
    const user = requireUser(request)
    const tag = loadTag(ctx.db, (request.params as { id: string }).id)
    loadProject(tag.projectId, user.id)
    updateTag(ctx.db, tag, updateCardTagBodySchema.parse(request.body))
    return readTagCatalog(ctx.db, tag.projectId)
  })

  app.post('/api/card-tags/:id/merge', async (request) => {
    const user = requireUser(request)
    const tag = loadTag(ctx.db, (request.params as { id: string }).id)
    loadProject(tag.projectId, user.id)
    mergeTags(ctx.db, tag, mergeCardTagBodySchema.parse(request.body).into)
    return readTagCatalog(ctx.db, tag.projectId)
  })

  app.delete('/api/card-tags/:id', async (request) => {
    const user = requireUser(request)
    const tag = loadTag(ctx.db, (request.params as { id: string }).id)
    loadProject(tag.projectId, user.id)
    deleteTag(ctx.db, tag)
    return readTagCatalog(ctx.db, tag.projectId)
  })

  app.post('/api/projects/:id/cards/order', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = reorderCardsBodySchema.parse(request.body)
    loadProject(id, user.id)

    const known = new Map(
      ctx.db
        .select({ id: cards.id, column: cards.column })
        .from(cards)
        .where(eq(cards.projectId, id))
        .all()
        .map((row) => [row.id, row.column]),
    )

    const placed = new Set<string>()
    for (const group of body.columns) {
      for (const cardId of group.ids) {
        if (!known.has(cardId)) {
          throw badRequest('card_not_in_project', 'Card {id} does not belong to this project.', {
            id: cardId,
          })
        }
        if (placed.has(cardId)) {
          throw badRequest('card_placed_twice', 'Card {id} appears in two columns.', { id: cardId })
        }
        placed.add(cardId)
      }
    }

    // Rewrite whole columns: partial updates would leave omitted cards at their old
    // positions, interleaved arbitrarily among new positions, and display an order
    // that nobody requested.
    const touched = new Set(body.columns.map((group) => group.column))
    for (const [cardId, column] of known) {
      if (touched.has(column) && !placed.has(cardId)) {
        throw badRequest(
          'card_column_incomplete',
          'Reordering column {column} requires all of its cards.',
          { column },
        )
      }
    }

    const now = Date.now()
    writeTransaction(ctx.db, (tx) => {
      for (const group of body.columns) {
        group.ids.forEach((cardId, index) => {
          const patch: Partial<typeof cards.$inferInsert> = {
            column: group.column,
            position: index,
          }
          // Changing columns moves a card through the workflow and counts as a modification.
          // Reordering vertically is organization only and must not mark an entire column
          // as recently modified.
          if (known.get(cardId) !== group.column) patch.updatedAt = now
          tx.update(cards).set(patch).where(eq(cards.id, cardId)).run()
        })
      }
    })
    board?.kick(id)

    return { ok: true }
  })
}

/**
 * Card thread, oldest first.
 *
 * Join the author conversation's title rather than just its ID: notes describe
 * a session's work, and its title identifies that session. Use a left join
 * because notes outlive their conversations.
 */
export function readNotes(ctx: AppContext, cardId: string): CardNoteDto[] {
  const rows = ctx.db
    .select({
      id: cardNotes.id,
      body: cardNotes.body,
      createdAt: cardNotes.createdAt,
      conversationId: cardNotes.conversationId,
      conversationTitle: conversations.title,
      agent: conversations.agent,
      userName: users.displayName,
      externalAuthor: cardNotes.externalAuthor,
      externalUrl: cardNotes.externalUrl,
      publication: cardNotes.publication,
      publicationError: cardNotes.publicationError,
    })
    .from(cardNotes)
    .leftJoin(conversations, eq(conversations.id, cardNotes.conversationId))
    .leftJoin(users, eq(users.id, cardNotes.userId))
    .where(eq(cardNotes.cardId, cardId))
    .orderBy(asc(cardNotes.createdAt))
    .all()

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.createdAt,
    externalUrl: row.externalUrl,
    publication: row.publication,
    publicationError: row.publicationError,
    author:
      row.externalAuthor !== null
        ? { kind: 'github' as const, login: row.externalAuthor }
        : row.userName !== null
        ? { kind: 'user' as const, name: row.userName }
        : {
            kind: 'agent' as const,
            agent: row.agent ?? 'claude',
            // Null when the conversation was deleted: keep the note without its link.
            conversationId: row.conversationTitle === null ? null : row.conversationId,
            conversationTitle: row.conversationTitle ?? '',
          },
  }))
}

/**
 * Moves a card from `todo` to `in_progress` when its first session starts.
 *
 * Triggered by the first message, never by detecting an active session: columns
 * are deliberately chosen positions changed only by actions. Cards further
 * along never move backward; restarting a session during review does not undo it.
 */
export function advanceCardOnLaunch(ctx: AppContext, cardId: string): void {
  ctx.db
    .update(cards)
    .set({ column: 'in_progress', updatedAt: Date.now() })
    .where(and(eq(cards.id, cardId), eq(cards.column, 'todo')))
    .run()
}

/** Shared with agents to preserve card references and placement. */
export function updateCard(
  db: Db,
  card: CardRow,
  body: { title?: string; description?: string; column?: CardColumn },
): void {
  const patch: Partial<typeof cards.$inferInsert> = {}
  if (body.title !== undefined) patch.title = body.title
  if (body.description !== undefined) patch.description = body.description
  if (body.column !== undefined && body.column !== card.column) {
    patch.column = body.column
    // Changing columns in the detail view appends to the destination column:
    // no gesture specifies another position.
    const [last] = db
      .select({ position: max(cards.position) })
      .from(cards)
      .where(and(eq(cards.projectId, card.projectId), eq(cards.column, body.column)))
      .all()
    patch.position = (last?.position ?? 0) + 1
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = Date.now()
    db.update(cards).set(patch).where(eq(cards.id, card.id)).run()
  }
  if (body.description !== undefined) syncCardReferences(db, card, body.description)
}

/**
 * Creates a card at the end of a column with its backlinks.
 *
 * Shared by board routes and agent requests (`create_card`) so number and position
 * calculations stay consistent rather than diverge across two implementations.
 */
export function createCard(
  db: Db,
  projectId: string,
  userId: string,
  body: { title: string; description: string; column: CardColumn },
): CardRow {
  const row = insertCard(db, projectId, userId, body)
  syncCardReferences(db, row, row.description)
  return row
}

function insertCard(
  db: Db,
  projectId: string,
  userId: string,
  body: { title: string; description: string; column: CardColumn },
): CardRow {
  const now = Date.now()
  // Calculate number and position within the insert transaction; otherwise two
  // simultaneous creations could read the same maximum and violate uniqueness.
  return writeTransaction(db, (tx) => {
    const [highest] = tx
      .select({ number: max(cards.number) })
      .from(cards)
      .where(eq(cards.projectId, projectId))
      .all()
    const [last] = tx
      .select({ position: max(cards.position) })
      .from(cards)
      .where(and(eq(cards.projectId, projectId), eq(cards.column, body.column)))
      .all()

    const created = {
      id: randomUUID(),
      projectId,
      number: (highest?.number ?? 0) + 1,
      title: body.title,
      description: body.description,
      column: body.column,
      // Append to the column: new ideas do not automatically take priority, and
      // inserting first would demote work already sorted.
      position: (last?.position ?? 0) + 1,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
      columnEnteredAt: now,
      doneByMerge: null,
    }
    tx.insert(cards).values(created).run()
    return created
  })
}

/**
 * Rewrites a card's backlinks from its description.
 *
 * A `#12` referencing no card in this project is not an error: preserve its text
 * without producing a link. Rejecting saves for dead references would let a typo
 * block editing, although descriptions are prose before they are structure.
 */
export function syncCardReferences(db: Db, card: CardRow, description: string): void {
  const numbers = parseCardReferences(description)
  // In issue text, `#15` means repository issue 15, not card 15: descriptions are
  // published and read on GitHub. Resolve the reference to the card tracking that
  // issue, if any.
  const issue = db
    .select({ repo: cardIssues.repo })
    .from(cardIssues)
    .where(and(eq(cardIssues.cardId, card.id), eq(cardIssues.detached, false)))
    .get()
  const targets =
    numbers.length === 0
      ? []
      : (issue
          ? db
              .select({ id: cardIssues.cardId })
              .from(cardIssues)
              .where(
                and(
                  eq(cardIssues.projectId, card.projectId),
                  eq(cardIssues.repo, issue.repo),
                  inArray(cardIssues.number, numbers),
                ),
              )
              .all()
          : db
              .select({ id: cards.id })
              .from(cards)
              .where(and(eq(cards.projectId, card.projectId), inArray(cards.number, numbers)))
              .all()
        )
          .map((row) => row.id)
          // A card referencing itself conveys nothing useful.
          .filter((id) => id !== card.id)

  writeTransaction(db, (tx) => {
    tx.delete(cardRefs).where(eq(cardRefs.sourceId, card.id)).run()
    if (targets.length > 0) {
      tx.insert(cardRefs)
        .values(targets.map((targetId) => ({ sourceId: card.id, targetId })))
        .run()
    }
  })
}

/** Checks that a card exists in this project before attaching a conversation. */
export function assertCardInProject(ctx: AppContext, cardId: string, projectId: string): void {
  const row = ctx.db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.projectId, projectId)))
    .get()
  if (!row) throw notFound('card_not_found', 'Card not found.')
}

/** Conversation card for the chip linking back to the board. */
export function readCardLink(ctx: AppContext, cardId: string | null): CardLinkDto | null {
  if (!cardId) return null
  const row = ctx.db
    .select({ id: cards.id, number: cards.number, title: cards.title, column: cards.column })
    .from(cards)
    .where(eq(cards.id, cardId))
    .get()
  return row ?? null
}


function parseJsonList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}
