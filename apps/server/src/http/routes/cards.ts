import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, inArray, max, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  cardNotes,
  cardRefs,
  cards,
  conversations,
  projects,
  users,
  worktrees,
  writeTransaction,
  type CardRow,
  type ProjectRow,
} from '@sillage/db'
import {
  createCardBodySchema,
  createCardNoteBodySchema,
  parseCardReferences,
  reorderCardsBodySchema,
  updateCardBodySchema,
  type CardConversationDto,
  type CardDto,
  type CardLinkDto,
  type CardNoteDto,
} from '@sillage/protocol'
import type { AppContext } from '../context.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

const MENTION_LIMIT = 20

/**
 * Le board : les cartes d'un projet, c'est-à-dire le travail à faire, distinct des
 * conversations qui l'exécutent.
 *
 * Ce fichier ne dérive rien. La colonne d'une carte est une position choisie, écrite
 * par un geste et par lui seul ; l'activité se lit sur les conversations rattachées et
 * l'état de merge dans git, tous deux hors de cette table. Une seule transition
 * automatique existe dans tout le chantier, `todo` vers `in_progress` au lancement
 * d'une session, et elle vit dans la route de création de conversation parce que c'est
 * l'envoi du message qui la déclenche, pas l'observation d'une session active.
 */
export function registerCardRoutes(app: FastifyInstance, ctx: AppContext): void {
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
   * Assemble les cartes d'un projet en un petit nombre de requêtes.
   *
   * Les conversations et les références se lisent en bloc plutôt que carte par carte :
   * un board de trente cartes ferait autrement quatre-vingt-dix requêtes pour un écran.
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
      conversations: sessions.get(row.id) ?? [],
      noteCount: notes.get(row.id) ?? 0,
      references: outgoing.get(row.id) ?? [],
      referencedBy: incoming.get(row.id) ?? [],
    }))
  }

  const readCard = (cardId: string, projectId: string): CardDto => {
    const row = ctx.db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!row) throw notFound('card_not_found', 'Card not found.')
    const [dto] = buildDtos(projectId, [row])
    if (!dto) throw notFound('card_not_found', 'Card not found.')
    return dto
  }

  /**
   * Réécrit les backlinks d'une carte d'après sa description.
   *
   * Un `#12` qui ne désigne aucune carte du projet n'est pas une erreur : il reste dans
   * le texte et ne produit simplement pas de lien. Refuser l'enregistrement pour une
   * référence morte ferait d'une faute de frappe un blocage, alors que la description
   * est de la prose avant d'être une structure.
   */
  const syncReferences = (card: CardRow, description: string): void => {
    const numbers = parseCardReferences(description)
    const targets =
      numbers.length === 0
        ? []
        : ctx.db
            .select({ id: cards.id })
            .from(cards)
            .where(and(eq(cards.projectId, card.projectId), inArray(cards.number, numbers)))
            .all()
            .map((row) => row.id)
            // Une carte qui se cite elle-même n'apprend rien à personne.
            .filter((id) => id !== card.id)

    writeTransaction(ctx.db, (tx) => {
      tx.delete(cardRefs).where(eq(cardRefs.sourceId, card.id)).run()
      if (targets.length > 0) {
        tx.insert(cardRefs)
          .values(targets.map((targetId) => ({ sourceId: card.id, targetId })))
          .run()
      }
    })
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
   * Cartes citables, pour l'autocomplétion `#` du composer.
   *
   * Distincte de la liste du board : celle-ci porte les sessions et les backlinks de
   * chaque carte, poids inutile pour une liste déroulante qui n'affiche qu'un numéro
   * et un titre.
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
              // Le numéro se cherche par préfixe et le titre par sous-chaîne : taper
              // « 1 » veut dire la carte 1, pas toutes celles dont le numéro contient un 1.
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
    const body = createCardBodySchema.parse(request.body)
    loadProject(id, user.id)

    const now = Date.now()
    // Numéro et position se calculent dans la transaction qui insère : deux créations
    // simultanées y liraient sinon le même maximum et se disputeraient l'unicité.
    const row = writeTransaction(ctx.db, (tx) => {
      const [highest] = tx
        .select({ number: max(cards.number) })
        .from(cards)
        .where(eq(cards.projectId, id))
        .all()
      const [last] = tx
        .select({ position: max(cards.position) })
        .from(cards)
        .where(and(eq(cards.projectId, id), eq(cards.column, body.column)))
        .all()

      const created = {
        id: randomUUID(),
        projectId: id,
        number: (highest?.number ?? 0) + 1,
        title: body.title,
        description: body.description,
        column: body.column,
        // En fin de colonne : une idée neuve n'est pas prioritaire par le seul fait
        // d'être neuve, et s'insérer en tête déclasserait ce qui a déjà été trié.
        position: (last?.position ?? 0) + 1,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      }
      tx.insert(cards).values(created).run()
      return created
    })

    syncReferences(row, row.description)
    return reply.status(201).send(readCard(row.id, id))
  })

  app.patch('/api/cards/:id', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateCardBodySchema.parse(request.body)
    const { card } = loadCard(id, user.id)

    const patch: Partial<typeof cards.$inferInsert> = {}
    if (body.title !== undefined) patch.title = body.title
    if (body.description !== undefined) patch.description = body.description
    if (body.column !== undefined && body.column !== card.column) {
      patch.column = body.column
      // Changer de colonne depuis le détail place la carte en fin de la nouvelle,
      // faute de geste qui dise où l'y poser.
      const [last] = ctx.db
        .select({ position: max(cards.position) })
        .from(cards)
        .where(and(eq(cards.projectId, card.projectId), eq(cards.column, body.column)))
        .all()
      patch.position = (last?.position ?? 0) + 1
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = Date.now()
      ctx.db.update(cards).set(patch).where(eq(cards.id, id)).run()
    }
    if (body.description !== undefined) syncReferences(card, body.description)

    return readCard(id, card.projectId)
  })

  app.delete('/api/cards/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { card, project } = loadCard(id, user.id)

    // Le propriétaire du projet range chez lui ; l'auteur peut défaire ce qu'il vient
    // de créer. Un tiers du cercle de confiance édite les cartes mais n'en supprime
    // pas, la suppression emportant les backlinks que d'autres ont posés.
    if (project.ownerId !== user.id && card.createdBy !== user.id) {
      throw forbidden(
        'card_delete_forbidden',
        'Only the project owner or the card author can delete it.',
      )
    }

    writeTransaction(ctx.db, (tx) => {
      // Les conversations survivent à leur carte et redeviennent ordinaires : elles
      // portent du travail réel, que le rangement du board n'a pas à emporter.
      tx.update(conversations).set({ cardId: null }).where(eq(conversations.cardId, id)).run()
      tx.delete(cards).where(eq(cards.id, id)).run()
    })

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
    loadCard(id, user.id)

    ctx.db
      .insert(cardNotes)
      .values({
        id: randomUUID(),
        cardId: id,
        conversationId: null,
        userId: user.id,
        body: body.body,
        createdAt: Date.now(),
      })
      .run()

    return reply.status(201).send(readNotes(ctx, id))
  })

  app.delete('/api/card-notes/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const note = ctx.db.select().from(cardNotes).where(eq(cardNotes.id, id)).get()
    if (!note) throw notFound('card_note_not_found', 'Note not found.')
    // La lecture du projet suffit à supprimer : les notes d'agent n'ont pas d'auteur
    // humain à protéger, et une note fausse doit pouvoir partir sans passer par son
    // propriétaire, qui est parfois un process mort depuis des jours.
    loadCard(note.cardId, user.id)

    ctx.db.delete(cardNotes).where(eq(cardNotes.id, id)).run()
    return reply.status(204).send()
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

    // Une colonne réécrite doit l'être en entier. Un envoi partiel laisserait les
    // cartes omises avec leurs anciennes positions, donc intercalées au hasard parmi
    // les nouvelles, et le board afficherait un ordre que personne n'a demandé.
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
          // Un changement de colonne est un mouvement dans le workflow, pas un simple
          // rangement : il vaut modification. Une réorganisation verticale n'en est
          // pas une et ne doit pas faire remonter toute la colonne en « modifiée ».
          if (known.get(cardId) !== group.column) patch.updatedAt = now
          tx.update(cards).set(patch).where(eq(cards.id, cardId)).run()
        })
      }
    })

    return { ok: true }
  })
}

/**
 * Le fil d'une carte, du plus ancien au plus récent.
 *
 * Le titre de la conversation auteure est joint plutôt que son seul identifiant : une
 * note dit ce qu'une session a fait, et « quelle session » se lit par son titre. La
 * jointure est gauche parce que la note lui survit.
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
    author:
      row.userName !== null
        ? { kind: 'user' as const, name: row.userName }
        : {
            kind: 'agent' as const,
            agent: row.agent ?? 'claude',
            // Null quand la conversation a été supprimée : la note reste, son lien non.
            conversationId: row.conversationTitle === null ? null : row.conversationId,
            conversationTitle: row.conversationTitle ?? '',
          },
  }))
}

/**
 * Passe une carte de `todo` à `in_progress` au lancement de sa première session.
 *
 * Déclenchée par l'envoi du premier message, jamais par la détection d'une session
 * active : la colonne est une position choisie, et seul un geste la change. Une carte
 * déjà plus loin dans le workflow ne recule pas — relancer une session sur une carte
 * en relecture n'annule pas la relecture.
 */
export function advanceCardOnLaunch(ctx: AppContext, cardId: string): void {
  ctx.db
    .update(cards)
    .set({ column: 'in_progress', updatedAt: Date.now() })
    .where(and(eq(cards.id, cardId), eq(cards.column, 'todo')))
    .run()
}

/** Vérifie qu'une carte existe dans ce projet, avant de lui rattacher une conversation. */
export function assertCardInProject(ctx: AppContext, cardId: string, projectId: string): void {
  const row = ctx.db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.projectId, projectId)))
    .get()
  if (!row) throw notFound('card_not_found', 'Card not found.')
}

/** La carte d'une conversation, pour la puce qui ramène au board depuis le fil. */
export function readCardLink(ctx: AppContext, cardId: string | null): CardLinkDto | null {
  if (!cardId) return null
  const row = ctx.db
    .select({ id: cards.id, number: cards.number, title: cards.title, column: cards.column })
    .from(cards)
    .where(eq(cards.id, cardId))
    .get()
  return row ?? null
}

