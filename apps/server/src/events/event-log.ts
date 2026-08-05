import { EventEmitter } from 'node:events'
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { conversations, events, type Db } from '@sillage/db'
import {
  sillageEventSchema,
  type BackgroundTask,
  type JournalEntry,
  type SillageEvent,
} from '@sillage/protocol'
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

/**
 * Tours du fil principal, comptés depuis le journal.
 *
 * Un par message de l'utilisateur : c'est le découpage de la réglette de repères
 * (`buildTurns` côté web), et les deux surfaces doivent s'accorder sur le même fil.
 * Compter aussi les messages de l'agent reviendrait à compter ses étapes, chacun de ses
 * appels d'outil en produisant un.
 *
 * Dérivé des messages et non des `turn.started`, dont il diffère dans les deux sens :
 * un tour s'ouvre aussi sans que personne n'écrive (reprise de session, réveil de
 * boucle, suite de plan), et un steer ajoute un message au tour en cours sans en ouvrir
 * un. Sur les conversations mesurées, un peu moins de la moitié s'écartent. C'est le
 * découpage du fil qui fait foi ici, pas le cycle de vie du runner : le nombre affiché
 * doit être celui des repères qu'on peut réellement atteindre.
 *
 * Sur `messageId` distinct et non sur les événements : un message arrive en plusieurs
 * `message.completed` (réflexion, puis appels d'outils). Les messages d'un sous-agent
 * portent un `parentToolCallId` et appartiennent à son fil, pas à celui-ci.
 *
 * Recompté plutôt qu'incrémenté : reconnaître le premier `message.completed` d'un
 * message demanderait de retenir le précédent, état de plus pour un compte qu'une
 * requête rend en une fois, et seulement en fin de tour.
 */
const TURN_COUNT = sql<number>`(
  select count(distinct ${events.payload} ->> '$.messageId')
  from ${events}
  where ${events.conversationId} = ${conversations.id}
    and ${events.type} = 'message.completed'
    and ${events.payload} ->> '$.role' = 'user'
    and coalesce(${events.payload} ->> '$.parentToolCallId', '') = ''
)`

/**
 * Poids d'une entrée sur disque, en octets et non en caractères : un fil accentué ou
 * riche en emoji pèse davantage que ce que `String.length` en dit.
 */
function byteSize(payload: string, raw: string | null): number {
  return Buffer.byteLength(payload) + (raw === null ? 0 : Buffer.byteLength(raw))
}

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
  append(
    conversationId: string,
    event: SillageEvent,
    raw?: unknown,
    rawFormat?: string,
  ): JournalEntry {
    const ts = Date.now()

    const entry = this.db.transaction((tx): JournalEntry => {
      const row = tx
        .select({ lastSeq: conversations.lastSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()

      if (!row) throw new Error(`Conversation inconnue : ${conversationId}`)
      const seq = row.lastSeq + 1

      const payload = JSON.stringify(event)
      const storedRaw = raw === undefined ? null : JSON.stringify(raw)

      tx.insert(events)
        .values({
          conversationId,
          seq,
          ts,
          type: event.type,
          payload,
          raw: storedRaw,
          rawFormat: raw === undefined ? null : (rawFormat ?? null),
        })
        .run()

      tx.update(conversations)
        .set({
          lastSeq: seq,
          updatedAt: ts,
          journalBytes: sql`${conversations.journalBytes} + ${byteSize(payload, storedRaw)}`,
        })
        .where(eq(conversations.id, conversationId))
        .run()

      // Dans la même transaction que l'écriture du journal : l'index ne peut pas
      // contenir un message que le journal n'aurait pas, ni l'inverse.
      if (event.type === 'message.completed') indexMessage(tx, conversationId, seq)

      return { conversationId, seq, ts, event }
    })

    this.bus.emit(conversationId, entry)
    this.bus.emit(ALL_EVENTS, entry)
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
    /** Provenance commune des `raw` du lot, quand ils viennent d'une même source. */
    rawFormat?: string,
  ): number {
    if (batch.length === 0) return 0

    const entries = this.db.transaction((tx): JournalEntry[] => {
      const row = tx
        .select({ lastSeq: conversations.lastSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()
      if (!row) throw new Error(`Conversation inconnue : ${conversationId}`)

      let bytes = 0
      const appended = batch.map((item, index): JournalEntry => {
        const seq = row.lastSeq + index + 1
        const payload = JSON.stringify(item.event)
        const storedRaw = item.raw === undefined ? null : JSON.stringify(item.raw)
        bytes += byteSize(payload, storedRaw)

        tx.insert(events)
          .values({
            conversationId,
            seq,
            ts: item.ts,
            type: item.event.type,
            payload,
            raw: storedRaw,
            rawFormat: item.raw === undefined ? null : (rawFormat ?? null),
          })
          .run()
        if (item.event.type === 'message.completed') indexMessage(tx, conversationId, seq)
        return { conversationId, seq, ts: item.ts, event: item.event }
      })

      // Le compte de tours est repris ici et pas au fil des insertions : un import
      // amène des messages entiers d'un coup, et une seule requête les couvre tous.
      tx.update(conversations)
        .set({
          lastSeq: row.lastSeq + batch.length,
          updatedAt: Date.now(),
          journalBytes: sql`${conversations.journalBytes} + ${bytes}`,
          turnCount: TURN_COUNT,
        })
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
   * `subAgentIds` : les appels dont le sous-agent a déjà laissé des traces au journal.
   * Un fil de sous-agent ne se découpe pas au point de reprise, il a sa propre
   * chronologie : c'est tout ou rien, et c'est cet ensemble qui le dit.
   *
   * Contrat Claude : `raw.uuid` est un identifiant d'entrée du transcript de Claude
   * Code, seul CLI à en écrire un. Les `raw` Codex n'en portent pas, la lecture est
   * donc inoffensive ailleurs, mais elle n'a de sens que pour cet adaptateur.
   */
  importAnchors(conversationId: string): {
    uuids: Set<string>
    completedToolCallIds: Set<string>
    subAgentIds: Set<string>
  } {
    const rows = this.db
      .select({ type: events.type, payload: events.payload, raw: events.raw })
      .from(events)
      .where(eq(events.conversationId, conversationId))
      .all()

    const uuids = new Set<string>()
    const completedToolCallIds = new Set<string>()
    const subAgentIds = new Set<string>()
    for (const row of rows) {
      if (row.raw) {
        const raw = JSON.parse(row.raw) as { uuid?: unknown }
        if (typeof raw.uuid === 'string') uuids.add(raw.uuid)
      }
      const payload = JSON.parse(row.payload) as {
        toolCallId?: unknown
        parentToolCallId?: unknown
      }
      if (row.type === 'tool.completed' && typeof payload.toolCallId === 'string') {
        completedToolCallIds.add(payload.toolCallId)
      }
      if (typeof payload.parentToolCallId === 'string') subAgentIds.add(payload.parentToolCallId)
    }
    return { uuids, completedToolCallIds, subAgentIds }
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
   * Les derniers événements de certains types, du plus récent au plus ancien.
   *
   * Replier un journal entier pour dire où en est une conversation coûterait le prix de
   * tout son historique à chaque appel. Ce qui décrit le présent tient dans les
   * dernières entrées, et `limit` borne la lecture.
   */
  latest(conversationId: string, types: string[], limit: number): JournalEntry[] {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, conversationId), inArray(events.type, types)))
      .orderBy(desc(events.seq))
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
   * Remet le compte de tours d'aplomb sur ce que contient le journal.
   *
   * Appelée en fin de tour : c'est le moment où les messages du tour sont tous écrits,
   * et une fois par tour suffit pour une ligne de sidebar.
   */
  refreshTurnCount(conversationId: string): void {
    this.db
      .update(conversations)
      .set({ turnCount: TURN_COUNT })
      .where(eq(conversations.id, conversationId))
      .run()
  }

  /** Nombre d'événements d'un type, sans les charger. */
  count(conversationId: string, type: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(and(eq(events.conversationId, conversationId), eq(events.type, type)))
      .get()

    return row?.n ?? 0
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
   * Les travaux de fond que le journal donne encore pour vivants.
   *
   * Même service que `openPrompts`, pour la liste de niveau. Le CLI publie l'ensemble
   * de ses travaux à chaque changement et ne publie rien en mourant : sa dernière liste
   * reste donc le dernier mot du journal, dont tout l'affichage est dérivé. C'est ce
   * relevé qui dit ce qu'il reste à clore quand le process s'en va.
   *
   * Rejoué dans l'ordre, avec la même sémantique que le fold côté web : la liste de
   * niveau remplace, une fin de travail retire, une fin de session vide tout.
   */
  openBackgroundTasks(conversationId: string): BackgroundTask[] {
    const rows = this.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          inArray(events.type, ['background.updated', 'task.completed', 'session.ended']),
        ),
      )
      .orderBy(asc(events.seq))
      .all()

    let live = new Map<string, BackgroundTask>()
    for (const row of rows) {
      if (row.type === 'session.ended') {
        live.clear()
        continue
      }

      const payload = JSON.parse(row.payload) as { tasks?: BackgroundTask[]; taskId?: string }
      if (row.type === 'background.updated') {
        live = new Map((payload.tasks ?? []).map((task) => [task.id, task]))
      } else if (typeof payload.taskId === 'string') {
        live.delete(payload.taskId)
      }
    }

    return [...live.values()]
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
      let bytes = 0
      rows.forEach((row, index) => {
        bytes += byteSize(row.payload, row.raw)
        tx.insert(events)
          .values({
            conversationId: toConversationId,
            seq: index + 1,
            ts: row.ts,
            type: row.type,
            payload: row.payload,
            raw: row.raw,
            rawFormat: row.rawFormat,
          })
          .run()
      })

      tx.update(conversations)
        .set({ lastSeq: rows.length, journalBytes: bytes, turnCount: TURN_COUNT })
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
   *
   * `topLevelOnly` écarte les événements produits par un sous-agent (payload portant
   * un `parentToolCallId`) : leur `raw` vient d'une sidechain du transcript, et un
   * point de coupe pris là viserait le mauvais fichier. Les événements d'avant le
   * champ n'en portent pas et restent inclus, comme avant.
   */
  lastRawOfType(
    conversationId: string,
    type: string,
    throughSeq: number,
    opts: { topLevelOnly?: boolean } = {},
  ): unknown {
    const conditions = [
      eq(events.conversationId, conversationId),
      eq(events.type, type),
      lte(events.seq, throughSeq),
    ]
    if (opts.topLevelOnly) {
      conditions.push(sql`coalesce(${events.payload} ->> '$.parentToolCallId', '') = ''`)
    }

    const row = this.db
      .select({ raw: events.raw })
      .from(events)
      .where(and(...conditions))
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

  /**
   * Toutes les conversations à la fois, pour les consommateurs transverses (webhooks).
   *
   * Volontairement absent du chemin des imports (`appendBatch`) : rejouer un transcript
   * n'est pas de l'activité, et notifier un appelant pour chaque événement importé
   * l'inonderait de tours vieux de plusieurs jours.
   */
  subscribeAll(listener: (entry: JournalEntry) => void): () => void {
    this.bus.on(ALL_EVENTS, listener)
    return () => this.bus.off(ALL_EVENTS, listener)
  }
}

/** Canal du bus réservé aux abonnés transverses ; hors de portée d'un id de conversation. */
const ALL_EVENTS = Symbol('all-events')
