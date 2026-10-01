import { and, asc, count, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { randomUUID } from 'node:crypto'
import {
  conversations,
  events,
  sessionMessages,
  sessionWatches,
  type Db,
  type SessionMessageRow,
} from '@sillage/db'
import { formatSessionMessage } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { SessionManager } from './session-manager.js'

/**
 * Remet aux sessions les messages que d'autres sessions leur ont laissés.
 *
 * Le serveur MCP dépose le message en base, faute de mieux : il n'a qu'un accès au
 * fichier, pas aux runners. Le relais balaie ces dépôts et les remet par les gestes que
 * l'utilisateur a déjà : une inflexion si le destinataire travaille, un message ordinaire
 * sinon, qui le relance.
 *
 * Il tient aussi les surveillances de `notify_when_done` : c'est lui qui voit passer les
 * statuts, et la fin d'une session devient un message comme un autre.
 *
 * Un balayage et non une notification : les deux process ne partagent que SQLite, qui ne
 * prévient pas d'une écriture faite par un autre. Deux secondes sont invisibles à
 * l'échelle d'un tour d'agent, et les requêtes tiennent dans des index.
 */

const POLL_MS = 2000

/**
 * Profondeur au-delà de laquelle une réponse ne relance plus son destinataire.
 *
 * Deux agents polis se remercient indéfiniment, chacun relancé par l'autre, et brûlent
 * des jetons sans que personne regarde. La chaîne `reply_to` compte les allers-retours ;
 * passé ce seuil le message est retenu, et le fil du destinataire le montre pour qu'une
 * personne le remette ou l'écarte.
 *
 * Doit rester d'accord avec `apps/server/src/mcp/sillage-mcp.mjs`, qui prévient
 * l'expéditeur au moment de l'envoi.
 */
export const MAX_HOPS = 6

/**
 * Relances par destinataire et par heure, quelle que soit la chaîne.
 *
 * Le garde-fou précédent suppose que l'agent renseigne `reply_to`, ce que rien n'oblige.
 * Celui-ci ne suppose rien : une session réveillée six fois en une heure par ses voisines
 * attend désormais une personne. Même accord à tenir avec le serveur MCP.
 */
export const WAKES_PER_HOUR = 6

/**
 * Âge au-delà duquel un message n'est plus remis, ni une surveillance tenue.
 *
 * Retenu un jour entier, un message ne parle plus de l'état présent et tomberait au
 * milieu d'un autre travail comme une consigne. Il reste lisible par l'outil.
 */
const STALE_MS = 24 * 60 * 60 * 1000

/** Le dernier message d'une session qui a fini, tel qu'il est cité à qui l'attendait. */
const DONE_EXCERPT_CHARS = 1500

type Outcome =
  | { via: 'steer' | 'queue' | 'wake' | 'failed' | 'skipped' }
  | { via: 'held'; reason: 'loop' | 'rate' }

const STATUS_WORDS: Record<string, string> = {
  idle: 'au repos',
  interrupted: 'interrompue',
  error: 'en erreur',
}

export class SessionRelay {
  private timer: NodeJS.Timeout | null = null
  /** Un balayage ne démarre pas tant que le précédent attend encore un CLI. */
  private busy = false
  /** Posé par `start` : le logger est celui de l'application, construite après. */
  private logger: FastifyBaseLogger | null = null

  constructor(
    private readonly db: Db,
    private readonly sessions: SessionManager,
    private readonly log: EventLog,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    this.timer = setInterval(() => void this.sweep(), POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async sweep(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      this.fireWatches()

      const pending = this.db
        .select()
        .from(sessionMessages)
        .where(isNull(sessionMessages.deliveredAt))
        .orderBy(asc(sessionMessages.createdAt))
        .limit(100)
        .all()

      for (const message of pending) {
        if (message.createdAt < Date.now() - STALE_MS) {
          this.settle(message.id, message.kind === 'broadcast' ? 'skipped' : 'expired')
          continue
        }
        await this.attempt(message, false)
      }

      this.closeHeld()
    } finally {
      this.busy = false
    }
  }

  /**
   * Remet un message retenu, à la demande d'une personne.
   *
   * Les garde-fous ne s'appliquent plus : ils existent pour qu'aucun échange ne tourne
   * sans témoin, et quelqu'un vient justement de regarder.
   */
  async release(conversationId: string, messageId: string): Promise<boolean> {
    const message = this.pendingFor(conversationId, messageId)
    if (!message) return false
    await this.attempt(message, true)
    this.closeHeld()
    return true
  }

  discard(conversationId: string, messageId: string): boolean {
    const message = this.pendingFor(conversationId, messageId)
    if (!message) return false
    this.settle(message.id, 'discarded')
    this.closeHeld()
    return true
  }

  private pendingFor(conversationId: string, messageId: string) {
    return this.db
      .select()
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.id, messageId),
          eq(sessionMessages.toConversationId, conversationId),
          isNull(sessionMessages.deliveredAt),
        ),
      )
      .get()
  }

  private async attempt(message: SessionMessageRow, force: boolean): Promise<void> {
    const outcome = await this.deliver(message, force).catch((err: unknown): Outcome => {
      this.logger?.warn({ err, message: message.id }, 'message entre sessions non remis')
      return { via: 'failed' }
    })

    if (outcome.via !== 'held') {
      this.settle(message.id, outcome.via)
      return
    }

    // Annoncé une fois : le message est réexaminé à chaque balayage, et redémarrer le
    // daemon ne doit pas le faire apparaître deux fois dans le fil.
    if (message.heldAt !== null) return
    this.db
      .update(sessionMessages)
      .set({ heldAt: Date.now() })
      .where(eq(sessionMessages.id, message.id))
      .run()
    this.log.append(message.toConversationId, {
      type: 'session_message.held',
      messageId: message.id,
      text: this.frame(message),
      reason: outcome.reason,
    })
  }

  private settle(id: string, via: NonNullable<SessionMessageRow['deliveredVia']>): void {
    this.db
      .update(sessionMessages)
      .set({ deliveredAt: Date.now(), deliveredVia: via })
      // Le destinataire a pu le lire par l'outil pendant la remise : son marquage est
      // le bon, il ne faut pas l'écraser.
      .where(and(eq(sessionMessages.id, id), isNull(sessionMessages.deliveredAt)))
      .run()
  }

  /**
   * Retire du fil les retenues dont le message est parti, quelle que soit la voie.
   *
   * Balayé plutôt qu'appelé au moment de la remise : un message retenu peut aussi être
   * lu par `read_session_messages`, depuis le process MCP, qui n'a pas accès au journal.
   * `heldAt` repasse à nul une fois l'annonce close, c'est ce qui la rend unique.
   */
  private closeHeld(): void {
    const closed = this.db
      .select()
      .from(sessionMessages)
      .where(and(isNotNull(sessionMessages.heldAt), isNotNull(sessionMessages.deliveredAt)))
      .all()

    for (const message of closed) {
      const via = message.deliveredVia
      this.log.append(message.toConversationId, {
        type: 'session_message.released',
        messageId: message.id,
        reason: via === 'read' || via === 'discarded' || via === 'expired' ? via : 'delivered',
      })
      this.db
        .update(sessionMessages)
        .set({ heldAt: null })
        .where(eq(sessionMessages.id, message.id))
        .run()
    }
  }

  private async deliver(message: SessionMessageRow, force: boolean): Promise<Outcome> {
    const recipient = this.conversation(message.toConversationId)
    if (!recipient || recipient.archivedAt !== null) return { via: 'failed' }

    const text = this.frame(message)

    // L'identifiant du message sert d'identifiant client : si la remise est rejouée
    // après un échec d'écriture du marquage, la déduplication du gestionnaire l'avale.
    if (recipient.status === 'running') {
      if (await this.sessions.steer(recipient.id, message.id, text)) return { via: 'steer' }
      // Le tour a fini entre la lecture du statut et l'inflexion : le message part en
      // message ordinaire, qui attendra la fin du tour s'il en reste un.
      const now = this.conversation(recipient.id)
      if (now?.status === 'running' || now?.status === 'awaiting_input') {
        await this.sessions.sendMessage(recipient.id, message.id, text)
        return { via: 'queue' }
      }
    }

    // Une sollicitation en attente : le message passe derrière la réponse humaine.
    if (recipient.status === 'awaiting_input') {
      await this.sessions.sendMessage(recipient.id, message.id, text)
      return { via: 'queue' }
    }

    // Une annonce ne vaut que pour qui travaille au moment où elle est faite : relancer
    // une session au repos pour lui dire qu'on redémarre le service n'a pas de sens.
    if (message.kind === 'broadcast') return { via: 'skipped' }

    // Une fin de travail a été demandée explicitement : elle relance sans compter.
    if (message.kind === 'message' && !force) {
      const held = this.holdReason(message)
      if (held) return { via: 'held', reason: held }
    }
    await this.sessions.sendMessage(recipient.id, message.id, text)
    return { via: 'wake' }
  }

  private holdReason(message: SessionMessageRow): 'loop' | 'rate' | null {
    if (this.hops(message) >= MAX_HOPS) return 'loop'

    const [row] = this.db
      .select({ total: count() })
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.toConversationId, message.toConversationId),
          eq(sessionMessages.kind, 'message'),
          eq(sessionMessages.deliveredVia, 'wake'),
          gt(sessionMessages.deliveredAt, Date.now() - 60 * 60 * 1000),
        ),
      )
      .all()
    return (row?.total ?? 0) >= WAKES_PER_HOUR ? 'rate' : null
  }

  /** Longueur de la chaîne de réponses, bornée : au-delà du seuil, compter ne sert plus. */
  private hops(message: SessionMessageRow): number {
    let depth = 0
    let parent = message.replyTo
    while (parent && depth < MAX_HOPS) {
      depth++
      parent =
        this.db
          .select({ replyTo: sessionMessages.replyTo })
          .from(sessionMessages)
          .where(eq(sessionMessages.id, parent))
          .get()?.replyTo ?? null
    }
    return depth
  }

  /**
   * Dépose un message `done` pour chaque surveillance dont la cible a fini.
   *
   * « Fini » veut dire plus rien en cours : ni tour, ni travail de fond, ni boucle, et
   * pas de sollicitation en attente, qui n'est qu'une pause. Le message part ensuite
   * par le chemin ordinaire, dans le même balayage.
   */
  private fireWatches(): void {
    const open = this.db.select().from(sessionWatches).where(isNull(sessionWatches.firedAt)).all()

    for (const watch of open) {
      const fire = () =>
        this.db
          .update(sessionWatches)
          .set({ firedAt: Date.now() })
          .where(eq(sessionWatches.id, watch.id))
          .run()

      if (watch.createdAt < Date.now() - STALE_MS) {
        fire()
        continue
      }

      const target = this.db
        .select({
          status: conversations.status,
          background: conversations.backgroundCount,
          loops: conversations.loopCount,
          archivedAt: conversations.archivedAt,
        })
        .from(conversations)
        .where(eq(conversations.id, watch.targetConversationId))
        .get()

      const working =
        target &&
        target.archivedAt === null &&
        (target.status === 'running' ||
          target.status === 'awaiting_input' ||
          target.background > 0 ||
          target.loops > 0)
      if (working) continue

      const body = !target
        ? "Cette session n'existe plus."
        : target.archivedAt !== null
          ? 'Cette session a été archivée.'
          : this.doneBody(watch.targetConversationId, target.status)

      this.db
        .insert(sessionMessages)
        .values({
          id: randomUUID(),
          projectId: watch.projectId,
          fromConversationId: watch.targetConversationId,
          toConversationId: watch.watcherConversationId,
          kind: 'done',
          body,
          createdAt: Date.now(),
        })
        .run()
      fire()
    }
  }

  private doneBody(conversationId: string, status: string): string {
    const state = `La session est ${STATUS_WORDS[status] ?? status}.`
    const last = this.lastAgentText(conversationId)
    if (!last) return `${state} Elle n'a laissé aucun message.`

    const clipped =
      last.length > DONE_EXCERPT_CHARS ? `${last.slice(0, DONE_EXCERPT_CHARS)}\n[...]` : last
    return `${state} Son dernier message :\n\n${clipped
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`
  }

  /** Le dernier texte de l'agent dans le fil principal, sous-agents exclus. */
  private lastAgentText(conversationId: string): string | null {
    const rows = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(
and(eq(events.conversationId, conversationId), eq(events.type, 'message.completed')),
      )
      .orderBy(desc(events.seq))
      .limit(30)
      .all()

    for (const row of rows) {
      const event = JSON.parse(row.payload) as {
        role?: string
        parentToolCallId?: string | null
        blocks?: { type: string; text?: string }[]
      }
      if (event.role !== 'assistant' || event.parentToolCallId) continue
      const text = (event.blocks ?? [])
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) return text
    }
    return null
  }

  private conversation(id: string) {
    return this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        agent: conversations.agent,
        status: conversations.status,
        archivedAt: conversations.archivedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id))
      .get()
  }

  /** Le message tel que le destinataire le lit, voir `formatSessionMessage`. */
  private frame(message: SessionMessageRow): string {
    const sender = this.conversation(message.fromConversationId)
    return formatSessionMessage({
      kind: message.kind,
      from: message.fromConversationId,
      title: sender?.title ?? message.fromConversationId,
      agent: sender?.agent ?? '?',
      messageId: message.id,
      body: message.body,
    })
  }
}
