import { EventEmitter } from 'node:events'
import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm'
import { conversations, events, type Db } from '@sillage/db'
import { sillageEventSchema, type JournalEntry, type SillageEvent } from '@sillage/protocol'
import { indexConversation, indexMessage } from '../search/search-index.js'

/**
 * Le journal (invariant I2 de la spec).
 *
 * Tout ce que produit un agent est écrit ici avant d'être diffusé. Les clients ne
 * reçoivent jamais un événement qui ne serait pas déjà persisté, donc une coupure
 * réseau ne peut pas faire perdre d'information : à la reconnexion, le client rejoue
 * depuis son curseur.
 *
 * `seq` est strictement croissant par conversation. Il peut comporter des trous après
 * compaction des deltas ; la lecture se fait toujours par `seq > curseur`, jamais par
 * incrément supposé.
 */
/** Les trois formes d'interaction bloquante, indexées par l'événement qui les ouvre. */
const PROMPT_KINDS: Record<string, PromptKind | undefined> = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'plan.review_requested': 'plan',
  'elicitation.requested': 'elicitation',
}

const RESOLUTIONS: Record<PromptKind, string> = {
  permission: 'permission.resolved',
  question: 'question.resolved',
  plan: 'plan.review_resolved',
  elicitation: 'elicitation.resolved',
}

export type PromptKind = 'permission' | 'question' | 'plan' | 'elicitation'

export class EventLog {
  private readonly bus = new EventEmitter()

  constructor(private readonly db: Db) {
    // Une conversation très suivie (plusieurs onglets, mobile et desktop) dépasse
    // vite la limite par défaut de 10 écouteurs.
    this.bus.setMaxListeners(200)
  }

  /**
   * Incrémente `seq` et insère l'événement dans la même transaction : deux écritures
   * concurrentes sur la même conversation ne peuvent pas obtenir le même numéro.
   */
  append(conversationId: string, event: SillageEvent, raw?: unknown): JournalEntry {
    const ts = Date.now()

    const entry = this.db.transaction((tx): JournalEntry => {
      const row = tx
        .select({ lastSeq: conversations.lastSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()

      if (!row) throw new Error(`Conversation inconnue : ${conversationId}`)
      const seq = row.lastSeq + 1

      tx.insert(events)
        .values({
          conversationId,
          seq,
          ts,
          type: event.type,
          payload: JSON.stringify(event),
          raw: raw === undefined ? null : JSON.stringify(raw),
        })
        .run()

      tx.update(conversations)
        .set({ lastSeq: seq, updatedAt: ts })
        .where(eq(conversations.id, conversationId))
        .run()

      // Dans la même transaction que l'écriture du journal : l'index ne peut pas
      // contenir un message que le journal n'aurait pas, ni l'inverse.
      if (event.type === 'message.completed') indexMessage(tx, conversationId, seq)

      return { conversationId, seq, ts, event }
    })

    this.bus.emit(conversationId, entry)
    return entry
  }

  /**
   * Ajoute d'un bloc les événements traduits d'un transcript CLI (import ou
   * resynchronisation), avec leurs dates d'origine.
   *
   * Une transaction pour l'ensemble : un import de plusieurs centaines d'événements
   * en autant de transactions multiplierait les fsync pour rien, et un échec à
   * mi-course laisserait un fil tronqué sans que rien ne le dise. La diffusion sur le
   * bus reste par événement, comme pour `append` : un onglet déjà abonné voit la
   * resynchronisation arriver en direct.
   */
  appendBatch(
    conversationId: string,
    batch: { ts: number; event: SillageEvent; raw?: unknown }[],
  ): number {
    if (batch.length === 0) return 0

    const entries = this.db.transaction((tx): JournalEntry[] => {
      const row = tx
        .select({ lastSeq: conversations.lastSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()
      if (!row) throw new Error(`Conversation inconnue : ${conversationId}`)

      const appended = batch.map((item, index): JournalEntry => {
        const seq = row.lastSeq + index + 1
        tx.insert(events)
          .values({
            conversationId,
            seq,
            ts: item.ts,
            type: item.event.type,
            payload: JSON.stringify(item.event),
            raw: item.raw === undefined ? null : JSON.stringify(item.raw),
          })
          .run()
        if (item.event.type === 'message.completed') indexMessage(tx, conversationId, seq)
        return { conversationId, seq, ts: item.ts, event: item.event }
      })

      tx.update(conversations)
        .set({ lastSeq: row.lastSeq + batch.length, updatedAt: Date.now() })
        .where(eq(conversations.id, conversationId))
        .run()

      return appended
    })

    for (const entry of entries) this.bus.emit(conversationId, entry)
    return entries.at(-1)?.seq ?? 0
  }

  /**
   * Repères pour aligner le journal sur le transcript CLI.
   *
   * `uuids` : identifiants de transcript déjà connus, portés par les `raw` (le flux
   * vivant comme l'import les conservent). Le dernier commun aux deux côtés donne le
   * point de reprise. `completedToolCallIds` : les résultats d'outils déjà
   * journalisés, dont l'entrée de transcript peut se trouver après ce point quand un
   * tour a été interrompu, et qu'il ne faut pas réimporter en doublon.
   */
  importAnchors(conversationId: string): {
    uuids: Set<string>
    completedToolCallIds: Set<string>
  } {
    const rows = this.db
      .select({ type: events.type, payload: events.payload, raw: events.raw })
      .from(events)
      .where(eq(events.conversationId, conversationId))
      .all()

    const uuids = new Set<string>()
    const completedToolCallIds = new Set<string>()
    for (const row of rows) {
      if (row.raw) {
        const raw = JSON.parse(row.raw) as { uuid?: unknown }
        if (typeof raw.uuid === 'string') uuids.add(raw.uuid)
      }
      if (row.type === 'tool.completed') {
        const payload = JSON.parse(row.payload) as { toolCallId?: unknown }
        if (typeof payload.toolCallId === 'string') completedToolCallIds.add(payload.toolCallId)
      }
    }
    return { uuids, completedToolCallIds }
  }

  read(conversationId: string, afterSeq: number, limit: number): JournalEntry[] {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, conversationId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
      .limit(limit)
      .all()

    return rows.map((row) => ({
      conversationId: row.conversationId,
      seq: row.seq,
      ts: row.ts,
      event: this.parseStored(row.seq, row.payload),
    }))
  }

  /**
   * Demandes d'interaction encore ouvertes : une requête dont la résolution n'a jamais
   * été journalisée.
   *
   * Un daemon tué net n'exécute pas la sortie de ses runners, donc rien ne vient
   * clore les demandes en cours. Sans ce relevé, le fil rejoué garderait
   * indéfiniment une question posée et une conversation coincée en attente.
   */
  openPrompts(conversationId: string): { kind: PromptKind; requestId: string }[] {
    const rows = this.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          inArray(events.type, [...Object.keys(PROMPT_KINDS), ...Object.values(RESOLUTIONS)]),
        ),
      )
      .orderBy(asc(events.seq))
      .all()

    const open = new Map<string, PromptKind>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { requestId?: string }
      if (typeof payload.requestId !== 'string') continue

      const kind = PROMPT_KINDS[row.type]
      if (kind) open.set(payload.requestId, kind)
      else open.delete(payload.requestId)
    }

    return [...open].map(([requestId, kind]) => ({ kind, requestId }))
  }

  /**
   * Copie le début d'un journal vers une autre conversation, pour un fork.
   *
   * `raw` est copié aussi : c'est lui qui porte l'identifiant de transcript dont un
   * fork ultérieur de la branche aura besoin (invariant I3). Les `seq` sont renumérotés
   * depuis 1, la nouvelle conversation ayant sa propre séquence.
   *
   * Le fil forké serait vide sans cette copie, alors que l'agent, lui, se souvient :
   * c'est exactement le genre d'écart entre affichage et réalité que l'invariant I2
   * interdit.
   */
  copyThrough(fromConversationId: string, toConversationId: string, throughSeq: number): number {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, fromConversationId), lte(events.seq, throughSeq)))
      .orderBy(asc(events.seq))
      .all()

    this.db.transaction((tx) => {
      rows.forEach((row, index) => {
        tx.insert(events)
          .values({
            conversationId: toConversationId,
            seq: index + 1,
            ts: row.ts,
            type: row.type,
            payload: row.payload,
            raw: row.raw,
          })
          .run()
      })

      tx.update(conversations)
        .set({ lastSeq: rows.length })
        .where(eq(conversations.id, toConversationId))
        .run()

      // La copie n'emprunte pas `append` : sans cette ligne, une branche resterait
      // introuvable par la recherche alors que son fil, lui, contient bien tout.
      indexConversation(tx, toConversationId)
    })

    return rows.length
  }

  /**
   * Payload natif du dernier événement d'un type donné, jusqu'à `throughSeq`.
   *
   * Sert au fork Claude : le point de coupe est une entrée du fichier de transcript,
   * dont l'identifiant n'existe que dans `raw`.
   */
  lastRawOfType(conversationId: string, type: string, throughSeq: number): unknown {
    const row = this.db
      .select({ raw: events.raw })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          eq(events.type, type),
          lte(events.seq, throughSeq),
        ),
      )
      .orderBy(desc(events.seq))
      .limit(1)
      .get()

    return row?.raw ? JSON.parse(row.raw) : null
  }

  /**
   * Payloads natifs d'un appel d'outil : celui de son démarrage et celui de sa fin.
   *
   * C'est là que vit le détail d'une modification de fichier, que le schéma normalisé
   * ne porte pas : le contenu écrit et l'extrait remplacé côté Claude, le patch
   * unifié côté Codex. L'invariant I3 n'est pas contourné pour autant : la lecture est
   * faite par l'adaptateur du CLI concerné, jamais par le frontend.
   */
  rawOfTool(conversationId: string, toolCallId: string): { started: unknown; completed: unknown } {
    const rows = this.db
      .select({ type: events.type, payload: events.payload, raw: events.raw })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          inArray(events.type, ['tool.started', 'tool.completed']),
        ),
      )
      .orderBy(asc(events.seq))
      .all()

    const found: { started: unknown; completed: unknown } = { started: null, completed: null }
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { toolCallId?: string }
      if (payload.toolCallId !== toolCallId || !row.raw) continue
      if (row.type === 'tool.started') found.started = JSON.parse(row.raw)
      else found.completed = JSON.parse(row.raw)
    }
    return found
  }

  /**
   * Nature du changement journalisé pour ce couple appel/fichier.
   *
   * Relue plutôt que reçue du client : c'est elle qui décide si un contenu écrit se
   * présente comme une création complète ou comme une réécriture sans point de
   * comparaison, et le journal en est la seule source (invariant I2).
   */
  fileEditAction(
    conversationId: string,
    toolCallId: string,
    path: string,
  ): 'created' | 'modified' | 'deleted' | null {
    const rows = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.conversationId, conversationId), eq(events.type, 'file.edited')))
      .all()

    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        toolCallId?: string
        path?: string
        action?: 'created' | 'modified' | 'deleted'
      }
      if (payload.toolCallId === toolCallId && payload.path === path) return payload.action ?? null
    }
    return null
  }

  /** Nombre d'événements d'un type donné, avant et après un point de coupe. */
  countByType(conversationId: string, type: string, throughSeq: number): { kept: number; total: number } {
    const rows = this.db
      .select({ seq: events.seq })
      .from(events)
      .where(and(eq(events.conversationId, conversationId), eq(events.type, type)))
      .all()

    return {
      kept: rows.filter((row) => row.seq <= throughSeq).length,
      total: rows.length,
    }
  }

  /**
   * Messages mis en file dont le départ n'a jamais été journalisé.
   *
   * Distinct de `openPrompts` : la clé est un `queueId`, et la résolution ne porte pas
   * de décision mais une raison de sortie.
   */
  openQueuedMessages(conversationId: string): string[] {
    const rows = this.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          inArray(events.type, ['message.queued', 'message.dequeued']),
        ),
      )
      .orderBy(asc(events.seq))
      .all()

    const open = new Set<string>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { queueId?: string }
      if (typeof payload.queueId !== 'string') continue
      if (row.type === 'message.queued') open.add(payload.queueId)
      else open.delete(payload.queueId)
    }

    return [...open]
  }

  /**
   * Les événements sont validés à la relecture, pas seulement castés.
   *
   * C'est ce qui applique les valeurs par défaut du schéma aux entrées écrites avant
   * l'ajout d'un champ : le journal est rejoué indéfiniment (invariant I2), donc une
   * ancienne forme doit continuer à produire un affichage juste plutôt qu'un `NaN`.
   */
  private parseStored(seq: number, payload: string): SillageEvent {
    const raw: unknown = JSON.parse(payload)
    const parsed = sillageEventSchema.safeParse(raw)
    if (parsed.success) return parsed.data

    // Un événement irrécupérable est remplacé par une erreur visible dans le fil :
    // le masquer laisserait un trou silencieux dans l'historique.
    return {
      type: 'error',
      code: 'event_unreadable',
      message: `Événement ${seq} illisible (${parsed.error.issues[0]?.message ?? 'forme inconnue'}).`,
      recoverable: true,
    }
  }

  subscribe(conversationId: string, listener: (entry: JournalEntry) => void): () => void {
    this.bus.on(conversationId, listener)
    return () => this.bus.off(conversationId, listener)
  }
}
