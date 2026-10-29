import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { cardTagLinks, cardTags, conversations, projects, writeTransaction, type CardTagRow, type Db, type Tx } from '@sillage/db'
import {
  CARD_TAG_COLORS,
  CARD_TAG_NAME_MAX,
  CARD_TAGS_PER_CARD_MAX,
  cardTagKey,
  normalizeCardTagName,
  type CardTagCatalogDto,
  type CardTagRefDto,
} from '@sillage/protocol'
import { badRequest, conflict, notFound } from '../http/errors.js'

/**
 * Board tags: a per-project catalog shared by the interface and agents.
 *
 * Both paths go through this module so naming rules (case-insensitive uniqueness, palette
 * rotation) cannot drift between a tag created by a person and one an agent named.
 */

/** Who creates a tag: a person, or an agent session acting for its account. */
export interface TagAuthor {
  userId: string | null
  conversationId: string | null
}

export function readTagCatalog(db: Db, projectId: string): CardTagCatalogDto {
  const project = db.select({ agentCardTags: projects.agentCardTags }).from(projects).where(eq(projects.id, projectId)).get()
  const usage = new Map(
    db
      .select({ tagId: cardTagLinks.tagId, total: count() })
      .from(cardTagLinks)
      .innerJoin(cardTags, eq(cardTags.id, cardTagLinks.tagId))
      .where(eq(cardTags.projectId, projectId))
      .groupBy(cardTagLinks.tagId)
      .all()
      .map((row) => [row.tagId, row.total]),
  )
  const rows = db
    .select({ tag: cardTags, conversationTitle: conversations.title })
    .from(cardTags)
    .leftJoin(conversations, eq(conversations.id, cardTags.createdByConversationId))
    .where(eq(cardTags.projectId, projectId))
    .orderBy(asc(cardTags.nameKey))
    .all()
  return {
    agentsCanCreate: project?.agentCardTags ?? true,
    tags: rows.map(({ tag, conversationTitle }) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      description: tag.description,
      cardCount: usage.get(tag.id) ?? 0,
      createdBy:
        tag.createdByConversationId && conversationTitle !== null
          ? { conversationId: tag.createdByConversationId, title: conversationTitle }
          : null,
      createdAt: tag.createdAt,
    })),
  }
}

/** Tags of several cards in one query, keyed by card. */
export function tagsOfCards(db: Db, cardIds: string[]): Map<string, CardTagRefDto[]> {
  const grouped = new Map<string, CardTagRefDto[]>()
  if (cardIds.length === 0) return grouped
  const rows = db
    .select({ cardId: cardTagLinks.cardId, id: cardTags.id, name: cardTags.name, color: cardTags.color })
    .from(cardTagLinks)
    .innerJoin(cardTags, eq(cardTags.id, cardTagLinks.tagId))
    .where(inArray(cardTagLinks.cardId, cardIds))
    .orderBy(asc(cardTags.nameKey))
    .all()
  for (const { cardId, ...tag } of rows) {
    const list = grouped.get(cardId) ?? []
    list.push(tag)
    grouped.set(cardId, list)
  }
  return grouped
}

/** The palette color used least in the project, so early tags stay distinguishable. */
function nextColor(db: Db | Tx, projectId: string): string {
  const used = db.select({ color: cardTags.color }).from(cardTags).where(eq(cardTags.projectId, projectId)).all()
  const counts = new Map(CARD_TAG_COLORS.map((color) => [color, 0]))
  for (const { color } of used) {
    const key = color.toUpperCase()
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = CARD_TAG_COLORS[0]!
  for (const color of CARD_TAG_COLORS) if ((counts.get(color) ?? 0) < (counts.get(best) ?? 0)) best = color
  return best
}

function findByKey(db: Db | Tx, projectId: string, key: string): CardTagRow | undefined {
  return db.select().from(cardTags).where(and(eq(cardTags.projectId, projectId), eq(cardTags.nameKey, key))).get()
}

export function createTag(
  db: Db,
  projectId: string,
  input: { name: string; color?: string; description?: string },
  author: TagAuthor,
): CardTagRow {
  const name = normalizeCardTagName(input.name)
  if (!name || name.length > CARD_TAG_NAME_MAX) {
    throw badRequest('card_tag_name_invalid', 'A tag name has 1 to {max} characters.', { max: CARD_TAG_NAME_MAX })
  }
  return writeTransaction(db, (tx) => {
    if (findByKey(tx, projectId, cardTagKey(name))) {
      throw conflict('card_tag_exists', 'A tag named “{name}” already exists.', { name })
    }
    const row: CardTagRow = {
      id: randomUUID(),
      projectId,
      name,
      nameKey: cardTagKey(name),
      color: input.color?.toUpperCase() ?? nextColor(tx, projectId),
      description: input.description?.trim() ?? '',
      createdBy: author.userId,
      createdByConversationId: author.conversationId,
      createdAt: Date.now(),
    }
    tx.insert(cardTags).values(row).run()
    return row
  })
}

export function loadTag(db: Db, tagId: string): CardTagRow {
  const tag = db.select().from(cardTags).where(eq(cardTags.id, tagId)).get()
  if (!tag) throw notFound('card_tag_not_found', 'Tag not found.')
  return tag
}

export function updateTag(db: Db, tag: CardTagRow, patch: { name?: string; color?: string; description?: string }): void {
  const next: Partial<CardTagRow> = {}
  if (patch.name !== undefined) {
    const name = normalizeCardTagName(patch.name)
    const other = findByKey(db, tag.projectId, cardTagKey(name))
    if (other && other.id !== tag.id) throw conflict('card_tag_exists', 'A tag named “{name}” already exists.', { name })
    next.name = name
    next.nameKey = cardTagKey(name)
  }
  if (patch.color !== undefined) next.color = patch.color.toUpperCase()
  if (patch.description !== undefined) next.description = patch.description.trim()
  if (Object.keys(next).length > 0) db.update(cardTags).set(next).where(eq(cardTags.id, tag.id)).run()
}

/** Folds a duplicate into another tag: cards keep one copy, the source disappears. */
export function mergeTags(db: Db, source: CardTagRow, targetId: string): void {
  const target = loadTag(db, targetId)
  if (target.projectId !== source.projectId) throw notFound('card_tag_not_found', 'Tag not found.')
  if (target.id === source.id) throw badRequest('card_tag_merge_self', 'A tag cannot be merged into itself.')
  writeTransaction(db, (tx) => {
    const tagged = tx.select({ cardId: cardTagLinks.cardId }).from(cardTagLinks).where(eq(cardTagLinks.tagId, source.id)).all()
    if (tagged.length > 0) {
      tx.insert(cardTagLinks)
        .values(tagged.map(({ cardId }) => ({ cardId, tagId: target.id })))
        .onConflictDoNothing()
        .run()
    }
    tx.delete(cardTags).where(eq(cardTags.id, source.id)).run()
  })
}

export function deleteTag(db: Db, tag: CardTagRow): void {
  db.delete(cardTags).where(eq(cardTags.id, tag.id)).run()
}

/** Replaces a card's tags; every id must be a tag of the card's project. */
export function setCardTags(db: Db, cardId: string, projectId: string, tagIds: string[]): void {
  const wanted = [...new Set(tagIds)]
  if (wanted.length > CARD_TAGS_PER_CARD_MAX) {
    throw badRequest('card_tags_too_many', 'A card has at most {max} tags.', { max: CARD_TAGS_PER_CARD_MAX })
  }
  if (wanted.length > 0) {
    const known = db
      .select({ id: cardTags.id })
      .from(cardTags)
      .where(and(eq(cardTags.projectId, projectId), inArray(cardTags.id, wanted)))
      .all()
    if (known.length !== wanted.length) throw notFound('card_tag_not_found', 'Tag not found.')
  }
  writeTransaction(db, (tx) => {
    tx.delete(cardTagLinks).where(eq(cardTagLinks.cardId, cardId)).run()
    if (wanted.length > 0) tx.insert(cardTagLinks).values(wanted.map((tagId) => ({ cardId, tagId }))).run()
  })
}

/**
 * Tag names an agent supplied, resolved to ids. Known names match regardless of case; unknown
 * ones are created when the project allows it, otherwise refused with the catalog so the agent
 * can retry with existing tags.
 */
export function resolveAgentTags(
  db: Db,
  projectId: string,
  names: unknown,
  author: TagAuthor,
): { ids: string[]; created: string[] } {
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new TagRefusal('`tags` is a list of tag names.')
  }
  const unique = [...new Map((names as string[]).map(normalizeCardTagName).filter(Boolean).map((name) => [cardTagKey(name), name])).values()]
  if (unique.length > CARD_TAGS_PER_CARD_MAX) throw new TagRefusal(`A card has at most ${CARD_TAGS_PER_CARD_MAX} tags.`)
  const tooLong = unique.find((name) => name.length > CARD_TAG_NAME_MAX)
  if (tooLong) throw new TagRefusal(`Tag “${tooLong}” is too long (maximum ${CARD_TAG_NAME_MAX} characters).`)

  const missing = unique.filter((name) => !findByKey(db, projectId, cardTagKey(name)))
  if (missing.length > 0) {
    const allowed = db.select({ agentCardTags: projects.agentCardTags }).from(projects).where(eq(projects.id, projectId)).get()?.agentCardTags ?? true
    if (!allowed) {
      const catalog = db.select({ name: cardTags.name }).from(cardTags).where(eq(cardTags.projectId, projectId)).orderBy(asc(cardTags.nameKey)).all()
      throw new TagRefusal(
        `Unknown tag(s): ${missing.join(', ')}. This project does not let agents create tags; use existing ones: ${catalog.map((tag) => tag.name).join(', ') || 'none defined'}.`,
      )
    }
    for (const name of missing) createTag(db, projectId, { name }, author)
  }
  return { ids: unique.map((name) => findByKey(db, projectId, cardTagKey(name))!.id), created: missing }
}

/** Agent-facing refusal, turned into a tool error by the request handler. */
export class TagRefusal extends Error {}
