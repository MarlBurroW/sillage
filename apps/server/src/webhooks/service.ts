import { createHmac, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm'
import {
  apiTaskOptions,
  apiTokens,
  conversations,
  webhookDeliveries,
  type ConversationRow,
  type Db,
} from '@sillage/db'
import type { JournalEntry, WebhookFailureReason, WebhookPayload } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import type { SessionManager } from '../sessions/session-manager.js'

/**
 * Livraison des webhooks de tâches, et surveillance des échéances de réponse.
 *
 * Le service écoute le journal entier et ne retient que ce qui concerne une tâche
 * d'API dont le jeton (ou la tâche) déclare une URL. Chaque livraison est écrite en
 * base avant le premier essai : un redémarrage reprend ce qui n'est pas parti, parce
 * qu'une notification perdue est précisément ce que l'appelant ne peut pas détecter.
 *
 * Un webhook part toujours, qu'un humain regarde le fil ou non : ne surtout pas
 * hériter du filtre `isWatched` des notifications push, écrit pour épargner un humain
 * déjà devant son écran, ce qu'un appelant machine n'est jamais.
 */

/**
 * Reprise exponentielle : 30 s puis ×4 à chaque échec, plafonnée à six heures
 * (30 s, 2 min, 8 min, 32 min, ~2 h, 6 h, 6 h), soit une quinzaine d'heures de
 * couverture. Après le dernier essai, la livraison est abandonnée en gardant sa trace
 * et sa dernière erreur.
 */
const RETRY_BASE_MS = 30 * 1000
const RETRY_FACTOR = 4
const RETRY_CAP_MS = 6 * 60 * 60 * 1000
const RETRY_MAX_ATTEMPTS = 8

function retryDelayMs(attempts: number): number | null {
  if (attempts >= RETRY_MAX_ATTEMPTS) return null
  return Math.min(RETRY_BASE_MS * RETRY_FACTOR ** (attempts - 1), RETRY_CAP_MS)
}
const SCAN_INTERVAL_MS = 15 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000
/** Fenêtre de rejeu côté consommateur, portée par l'horodatage de la signature. */

type PendingKind = 'permission' | 'question' | 'plan' | 'elicitation'

const REQUESTED_TYPES: Record<string, PendingKind | undefined> = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'plan.review_requested': 'plan',
  'elicitation.requested': 'elicitation',
}

const RESOLVED_TYPES = new Set([
  'permission.resolved',
  'question.resolved',
  'plan.review_resolved',
  'elicitation.resolved',
])

interface TaskTarget {
  conversation: ConversationRow
  tokenId: string
  url: string
  secret: string
  replyDeadlineSec: number
}

export class WebhookService {
  private unsubscribe: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private scanning = false
  /** Échéances armées, par requestId. Perdues au redémarrage, comme les sollicitations. */
  private readonly deadlines = new Map<string, NodeJS.Timeout>()
  /**
   * Dernier message envoyé par l'API par conversation, pour corréler le
   * `task.completed` qui en résultera. En mémoire : après un redémarrage la
   * corrélation vaut null, ce que le contrat du payload annonce.
   */
  private readonly lastClientMessage = new Map<string, string>()

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly sessions: SessionManager,
    /** `server.publicUrl` de la configuration ; vide, le lien du payload reste relatif. */
    private readonly publicUrl: string,
  ) {}

  start(): void {
    this.unsubscribe = this.log.subscribeAll((entry) => this.onEvent(entry))
    this.timer = setInterval(() => void this.deliverDue(), SCAN_INTERVAL_MS)
    this.timer.unref()
    void this.deliverDue()
  }

  stop(): void {
    this.unsubscribe?.()
    if (this.timer) clearInterval(this.timer)
    for (const timer of this.deadlines.values()) clearTimeout(timer)
    this.deadlines.clear()
  }

  /** Appelé par les routes v1 à chaque envoi, pour corréler le tour qui suivra. */
  trackMessage(conversationId: string, clientMessageId: string): void {
    this.lastClientMessage.set(conversationId, clientMessageId)
  }

  /**
   * Un arrêt demandé par quelqu'un d'autre que le jeton d'origine. Sans livraison
   * pour le jeton qui a lui-même interrompu : il le sait déjà.
   */
  taskStopped(conversationId: string, by: { kind: 'user' | 'token'; id: string; label: string }): void {
    const target = this.targetFor(conversationId)
    if (!target) return
    if (by.kind === 'token' && by.id === target.conversation.createdByTokenId) return

    this.enqueue(target, {
      type: 'task.stopped',
      by: { kind: by.kind, label: by.label },
    })
  }

  /**
   * Le service a redémarré et `recoverInterrupted` a clos les tâches en vol : chaque
   * déploiement orphelinerait en silence ce que l'appelant avait lancé si rien ne
   * partait ici.
   */
  sessionEnded(conversationIds: string[]): void {
    for (const id of conversationIds) {
      const target = this.targetFor(id)
      if (!target) continue
      this.enqueue(target, {
        type: 'task.failed',
        reason: 'session_ended',
        message: 'The server restarted; the CLI process and any open request died with it.',
      })
    }
  }

  /**
   * Le pendant du précédent pour l'arrêt propre : un SIGTERM passe par `stopAll`, qui
   * expire les sollicitations avant que le prochain démarrage ait quoi que ce soit à
   * récupérer. Les livraisons sont écrites maintenant, pendant que la base répond
   * encore, et partiront à la reprise : c'est précisément ce que la persistance permet.
   * À appeler avant `stopAll`, tant que les statuts disent encore ce qui était en vol.
   */
  shutdownFlush(): void {
    const inFlight = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          isNotNull(conversations.createdByTokenId),
          inArray(conversations.status, ['running', 'awaiting_input']),
        ),
      )
      .all()

    this.sessionEnded(inFlight.map((row) => row.id))
  }

  private onEvent(entry: JournalEntry): void {
    const type = entry.event.type
    const interesting =
      type === 'turn.completed' || type === 'error' || type in REQUESTED_TYPES || RESOLVED_TYPES.has(type)
    if (!interesting) return

    const target = this.targetFor(entry.conversationId)

    if (type in REQUESTED_TYPES) {
      const requested = entry.event as { requestId: string }
      // L'échéance s'arme même sans URL de webhook : elle protège les places de
      // session, pas la notification.
      this.armDeadline(entry.conversationId, requested.requestId)
      if (target) {
        const deadline = this.deadlineFor(entry.conversationId)
        this.enqueue(target, {
          type: 'task.awaiting_input',
          seq: entry.seq,
          pending: {
            kind: REQUESTED_TYPES[type]!,
            requestId: requested.requestId,
            event: entry.event,
          },
          ...(deadline > 0 ? { replyDeadlineAt: entry.ts + deadline * 1000 } : {}),
        })
      }
      return
    }

    if (RESOLVED_TYPES.has(type)) {
      const resolved = entry.event as { requestId: string }
      this.disarmDeadline(resolved.requestId)
      return
    }

    if (!target) return

    if (type === 'turn.completed') {
      const completed = entry.event as { stopReason: string | null }
      const clientMessageId = this.lastClientMessage.get(entry.conversationId) ?? null
      this.lastClientMessage.delete(entry.conversationId)
      this.enqueue(target, {
        type: 'task.completed',
        seq: entry.seq,
        clientMessageId,
        stopReason: completed.stopReason ?? 'unknown',
        lastMessage: this.lastAssistantText(entry.conversationId),
      })
      return
    }

    // `error` : seuls les cas qui tuent la tâche valent une livraison. Une erreur
    // récupérable se lira dans le journal, comme dans l'interface.
    const error = entry.event as { code?: string; message?: string; recoverable?: boolean }
    if (error.recoverable === false || error.code === 'runner_failed') {
      this.enqueue(target, {
        type: 'task.failed',
        seq: entry.seq,
        reason: 'runner_failed',
        message: error.message,
      })
    }
  }

  // Échéances

  private armDeadline(conversationId: string, requestId: string): void {
    const seconds = this.deadlineFor(conversationId)
    if (seconds <= 0) return

    this.disarmDeadline(requestId)
    const timer = setTimeout(() => {
      this.deadlines.delete(requestId)
      void this.expireReply(conversationId, requestId)
    }, seconds * 1000)
    timer.unref()
    this.deadlines.set(requestId, timer)
  }

  private disarmDeadline(requestId: string): void {
    const timer = this.deadlines.get(requestId)
    if (!timer) return
    clearTimeout(timer)
    this.deadlines.delete(requestId)
  }

  /** Échéance d'une conversation, en secondes. 0 pour une conversation hors API. */
  private deadlineFor(conversationId: string): number {
    const options = this.db
      .select({ replyDeadlineSec: apiTaskOptions.replyDeadlineSec })
      .from(apiTaskOptions)
      .where(eq(apiTaskOptions.conversationId, conversationId))
      .get()
    return options?.replyDeadlineSec ?? 0
  }

  /**
   * Personne n'a répondu à temps : on refuse la sollicitation, on interrompt pour
   * libérer la place de session, et on le dit. « Aussi longtemps qu'il le faut » a été
   * écrit pour un humain qui revient devant son écran ; un appelant machine peut ne
   * jamais revenir.
   */
  private async expireReply(conversationId: string, requestId: string): Promise<void> {
    // Null, comme `expireAll` : personne n'a décidé, et `permission_requests.decided_by`
    // référence `users.id`, donc toute autre valeur casserait la contrainte.
    const decidedBy = null
    const refused =
      this.sessions.resolvePermission(conversationId, requestId, {
        decision: 'denied',
        scope: 'once',
        decidedBy,
      }) ||
      this.sessions.answerQuestion(conversationId, requestId, {
        status: 'cancelled',
        answers: {},
        decidedBy,
      }) ||
      this.sessions.resolveElicitation(conversationId, requestId, {
        action: 'cancel',
        content: {},
        decidedBy,
      }) ||
      this.sessions.reviewPlan(conversationId, requestId, {
        decision: 'rejected',
        followUpMode: null,
        decidedBy,
      })

    if (!refused) return
    await this.sessions.interrupt(conversationId)

    const target = this.targetFor(conversationId)
    if (!target) return
    this.enqueue(target, {
      type: 'task.failed',
      reason: 'reply_deadline_exceeded' satisfies WebhookFailureReason,
      message: `No reply to request ${requestId} before the deadline; the request was refused and the task interrupted.`,
    })
  }

  // Livraison

  /** Cible d'une conversation : la tâche d'API avec une URL déclarée, sinon rien. */
  private targetFor(conversationId: string): TaskTarget | null {
    const row = this.db
      .select({ conversation: conversations, token: apiTokens, options: apiTaskOptions })
      .from(conversations)
      .innerJoin(apiTokens, eq(apiTokens.id, conversations.createdByTokenId))
      .leftJoin(apiTaskOptions, eq(apiTaskOptions.conversationId, conversations.id))
      .where(eq(conversations.id, conversationId))
      .get()

    if (!row) return null
    const url = row.options?.webhookUrl ?? row.token.webhookUrl
    if (!url || !row.token.webhookSecret) return null

    return {
      conversation: row.conversation,
      tokenId: row.token.id,
      url,
      secret: row.token.webhookSecret,
      replyDeadlineSec: row.options?.replyDeadlineSec ?? 0,
    }
  }

  private lastAssistantText(conversationId: string): string | null {
    const entries = this.log.latest(conversationId, ['message.completed'], 20)
    for (const entry of entries) {
      const event = entry.event as {
        role?: string
        parentToolCallId?: string | null
        blocks?: { type: string; text?: string }[]
      }
      if (event.role !== 'assistant' || event.parentToolCallId !== null) continue
      const text = (event.blocks ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) return text
    }
    return null
  }

  private enqueue(
    target: TaskTarget,
    partial: Partial<WebhookPayload> & { type: WebhookPayload['type'] },
  ): void {
    const now = Date.now()
    const payload: WebhookPayload = {
      taskId: target.conversation.id,
      projectId: target.conversation.projectId,
      seq: target.conversation.lastSeq,
      ts: now,
      clientMessageId: null,
      status: target.conversation.status,
      title: target.conversation.title,
      url: `${this.publicUrl.replace(/\/+$/, '')}/p/${target.conversation.projectId}/c/${target.conversation.id}`,
      ...partial,
    }

    this.db
      .insert(webhookDeliveries)
      .values({
        id: randomUUID(),
        tokenId: target.tokenId,
        conversationId: target.conversation.id,
        url: target.url,
        type: payload.type,
        payload: JSON.stringify(payload),
        attempts: 0,
        nextAttemptAt: now,
        deliveredAt: null,
        lastError: null,
        createdAt: now,
      })
      .run()

    void this.deliverDue()
  }

  /** Tente toutes les livraisons échues. Une seule passe à la fois. */
  private async deliverDue(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const due = this.db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            isNull(webhookDeliveries.deliveredAt),
            isNotNull(webhookDeliveries.nextAttemptAt),
            lte(webhookDeliveries.nextAttemptAt, Date.now()),
          ),
        )
        .limit(50)
        .all()

      for (const delivery of due) {
        await this.attempt(delivery.id, delivery.tokenId, delivery.url, delivery.payload, delivery.attempts)
      }
    } finally {
      this.scanning = false
    }
  }

  private async attempt(
    id: string,
    tokenId: string,
    url: string,
    body: string,
    attempts: number,
  ): Promise<void> {
    const secret = this.db
      .select({ webhookSecret: apiTokens.webhookSecret })
      .from(apiTokens)
      .where(eq(apiTokens.id, tokenId))
      .get()?.webhookSecret

    let error: string | null = null
    if (!secret) {
      error = 'webhook secret no longer exists'
    } else {
      try {
        const ts = Date.now()
        const signature = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sillage-Signature': `t=${ts},v1=${signature}`,
            'X-Sillage-Delivery': id,
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (response.ok) {
          this.db
            .update(webhookDeliveries)
            .set({ deliveredAt: Date.now(), lastError: null })
            .where(eq(webhookDeliveries.id, id))
            .run()
          return
        }
        error = `HTTP ${response.status}`
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }

    // Échec : on reprend selon le barème, ou on abandonne en gardant la trace.
    const nextDelay = retryDelayMs(attempts + 1)
    this.db
      .update(webhookDeliveries)
      .set({
        attempts: attempts + 1,
        lastError: error,
        nextAttemptAt: nextDelay === null ? null : Date.now() + nextDelay,
      })
      .where(eq(webhookDeliveries.id, id))
      .run()
  }
}
