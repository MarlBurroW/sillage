import { randomUUID } from 'node:crypto'
import { and, eq, inArray, or } from 'drizzle-orm'
import { cardRelations, cards, writeTransaction, type Db } from '@sillage/db'
import { CARD_RELATION_INVERSE, type CardRelationDto, type CardRelationKind, type StoredCardRelationKind } from '@sillage/protocol'
import { badRequest, conflict, notFound } from '../http/errors.js'

function projectCard(db: Db, projectId: string, number: number) {
  const card = db.select().from(cards).where(and(eq(cards.projectId, projectId), eq(cards.number, number))).get()
  if (!card) throw notFound('card_not_found', 'Card not found in this project.')
  return card
}

/** Inverse and symmetric links share the same row, preventing duplicates. */
function canonical(sourceId: string, targetId: string, kind: CardRelationKind) {
  if (['blocked_by', 'duplicated_by', 'child', 'replaced_by'].includes(kind)) {
    return { sourceId: targetId, targetId: sourceId, kind: CARD_RELATION_INVERSE[kind] as StoredCardRelationKind }
  }
  if (kind === 'related' && sourceId > targetId) return { sourceId: targetId, targetId: sourceId, kind }
  return { sourceId, targetId, kind: kind as StoredCardRelationKind }
}

export function listCardRelations(db: Db, projectId: string, number: number): CardRelationDto[] {
  const card = projectCard(db, projectId, number)
  const linked = db.select().from(cardRelations)
    .where(or(eq(cardRelations.sourceId, card.id), eq(cardRelations.targetId, card.id))).all()
  if (linked.length === 0) return []
  const peerIds = linked.map(link => link.sourceId === card.id ? link.targetId : link.sourceId)
  const peers = new Map(db.select().from(cards).where(and(eq(cards.projectId, projectId), inArray(cards.id, peerIds))).all().map(c => [c.id, c]))
  return linked.flatMap(link => {
    const outgoing = link.sourceId === card.id
    const peer = peers.get(outgoing ? link.targetId : link.sourceId)
    if (!peer) return []
    return [{ id: link.id, kind: outgoing ? link.kind : CARD_RELATION_INVERSE[link.kind],
      card: { id: peer.id, number: peer.number, title: peer.title, column: peer.column } }]
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.card.number - b.card.number)
}

export function linkCards(db: Db, projectId: string, number: number, target: number, kind: CardRelationKind): void {
  writeTransaction(db, () => {
    const source = projectCard(db, projectId, number)
    const destination = projectCard(db, projectId, target)
    if (source.id === destination.id) throw badRequest('card_relation_self', 'A card cannot be linked to itself.')
    const edge = canonical(source.id, destination.id, kind)
    const existing = db.select().from(cardRelations).where(and(
      eq(cardRelations.sourceId, edge.sourceId), eq(cardRelations.targetId, edge.targetId), eq(cardRelations.kind, edge.kind),
    )).get()
    if (existing) return
    if (edge.kind !== 'related') {
      const edges = db.select({ sourceId: cardRelations.sourceId, targetId: cardRelations.targetId })
        .from(cardRelations).innerJoin(cards, eq(cards.id, cardRelations.sourceId))
        .where(and(eq(cards.projectId, projectId), eq(cardRelations.kind, edge.kind))).all()
      if (edge.kind === 'parent' && edges.some(e => e.targetId === edge.targetId)) {
        throw conflict('card_relation_parent', 'This card already has a parent. Remove that relation first.')
      }
      // Chains must terminate: neither circular ancestry nor mutual blocking.
      const pending = [edge.targetId]
      const visited = new Set<string>()
      while (pending.length) {
        const id = pending.pop()!
        if (id === edge.sourceId) throw conflict('card_relation_cycle', 'This relation would create a cycle.')
        if (visited.has(id)) continue
        visited.add(id)
        for (const e of edges) if (e.sourceId === id) pending.push(e.targetId)
      }
    }
    db.insert(cardRelations).values({ id: randomUUID(), ...edge, createdAt: Date.now() }).run()
  })
}

export function unlinkCards(db: Db, projectId: string, number: number, target: number, kind: CardRelationKind): void {
  const source = projectCard(db, projectId, number)
  const destination = projectCard(db, projectId, target)
  const edge = canonical(source.id, destination.id, kind)
  db.delete(cardRelations).where(and(
    eq(cardRelations.sourceId, edge.sourceId), eq(cardRelations.targetId, edge.targetId), eq(cardRelations.kind, edge.kind),
  )).run()
}
