import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { and, eq } from 'drizzle-orm'
import {
  conversations,
  permissionRequests,
  type ConversationRow,
  type Db,
} from '@sillage/db'
import {
  parseAgentConfig,
  type ConversationStatus,
  type PushPayload,
  type SillageEvent,
} from '@sillage/protocol'
import { ClaudeRunner } from '../agents/claude/runner.js'
import { CodexRunner } from '../agents/codex/runner.js'
import type {
  AgentRunner,
  ElicitationAnswer,
  OutgoingAttachment,
  OutgoingMention,
  PermissionDecision,
  PlanReview,
  QuestionAnswer,
  RunnerContext,
} from '../agents/types.js'
import type { Config } from '../config.js'
import type { EventLog } from '../events/event-log.js'
import { resolveConversationCwd, resolveMention } from '../workspace.js'
import { HttpError, notFound } from '../http/errors.js'
import { forkAgentSession } from './fork.js'

/** Un message ecrit pendant un tour, en attente de la fin de celui-ci. */
interface QueuedMessage {
  queueId: string
  clientMessageId: string
  text: string
  attachments: OutgoingAttachment[]
  mentions: string[]
}

interface ManagedRunner {
  runner: AgentRunner
  lastActivity: number
  status: ConversationStatus
  idleTimer: NodeJS.Timeout | null
}

/** Fenêtre de déduplication des envois (invariant I5). Voir sendMessage(). */
const DEDUPE_TTL_MS = 5 * 60 * 1000

/**
 * Événements qui valent une notification, avec ce qu'ils annoncent.
 *
 * Liste nommée plutôt qu'une règle implicite : notifier chaque événement du journal
 * reviendrait à n'être lu par personne. Ne sont retenus que les moments où l'agent
 * réclame une décision, et la fin d'un tour, qu'on ne peut pas deviner de loin.
 */
const NOTIFIABLE: Partial<Record<SillageEvent['type'], string>> = {
  'permission.requested': 'Une autorisation est demandée',
  'question.requested': "L'agent te demande de choisir",
  'elicitation.requested': 'Un service demande une saisie',
  'plan.review_requested': 'Un plan attend ta validation',
  'turn.completed': "L'agent a terminé",
}

/** Ce que le gestionnaire attend de la couche de notification, sans la connaître. */
export interface ConversationNotifier {
  /** Vrai si ce compte a un onglet ouvert sur cette conversation, à l'instant. */
  isWatched(conversationId: string, userId: string): boolean
  notify(userId: string, payload: PushPayload): Promise<void>
}

export class SessionManager {
  private readonly runners = new Map<string, ManagedRunner>()
  private readonly recentClientMessages = new Map<string, number>()
  /**
   * Messages en attente, par conversation.
   *
   * En mémoire seulement : un message qui n'a jamais atteint le CLI n'a pas à survivre
   * à un redémarrage, et le journal porte déjà de quoi le clore proprement à la
   * reprise (voir `expireQueuedMessages`).
   */
  private readonly queues = new Map<string, QueuedMessage[]>()
  /**
   * Renseigné après coup : le hub WebSocket, qui sait qui regarde quoi, n'existe pas
   * encore quand le gestionnaire est construit.
   */
  private notifier: ConversationNotifier | null = null
  readonly statusBus = new EventEmitter()

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly config: Config,
  ) {
    this.statusBus.setMaxListeners(200)
  }

  /**
   * Au démarrage, aucune conversation ne peut légitimement être en cours : les
   * runners sont morts avec le process précédent. Les laisser en `running` afficherait
   * un état mensonger et bloquerait l'envoi de messages.
   */
  recoverInterrupted(): number {
    const stale = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.status, 'running'))
      .all()

    const awaiting = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.status, 'awaiting_input'))
      .all()

    for (const row of [...stale, ...awaiting]) {
      this.log.append(row.id, {
        type: 'error',
        code: 'daemon_restarted',
        message: "Le daemon a redémarré pendant cette conversation. L'agent a été interrompu.",
        recoverable: true,
      })
      this.expireOpenPrompts(row.id)
      this.expireQueuedMessages(row.id)
      this.log.append(row.id, { type: 'session.ended', reason: 'interrupted' })
      this.db
        .update(conversations)
        .set({ status: 'interrupted' })
        .where(eq(conversations.id, row.id))
        .run()
    }

    this.db
      .update(permissionRequests)
      .set({ status: 'expired', decidedAt: Date.now() })
      .where(eq(permissionRequests.status, 'pending'))
      .run()

    return stale.length + awaiting.length
  }

  /**
   * Clôt dans le journal les demandes restées sans réponse.
   *
   * Le fold de rendu ne connaît que le journal : sans ces événements, une permission
   * ou une question posée avant l'arrêt resterait affichée comme en attente, avec des
   * boutons qui ne répondent plus à personne.
   */
  private expireOpenPrompts(conversationId: string): void {
    for (const { kind, requestId } of this.log.openPrompts(conversationId)) {
      if (kind === 'permission') {
        this.log.append(conversationId, {
          type: 'permission.resolved',
          requestId,
          decision: 'expired',
          scope: 'once',
          decidedBy: null,
        })
      } else if (kind === 'elicitation') {
        this.log.append(conversationId, {
          type: 'elicitation.resolved',
          requestId,
          status: 'expired',
          content: {},
          decidedBy: null,
        })
      } else if (kind === 'question') {
        this.log.append(conversationId, {
          type: 'question.resolved',
          requestId,
          status: 'expired',
          answers: {},
          decidedBy: null,
        })
      } else {
        this.log.append(conversationId, {
          type: 'plan.review_resolved',
          requestId,
          decision: 'expired',
          followUpMode: null,
          decidedBy: null,
        })
      }
    }
  }

  private loadConversation(conversationId: string): ConversationRow {
    const row = this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!row) throw notFound('Conversation introuvable.')
    return row
  }

  /** Répertoire de travail d'une conversation, worktree compris. */
  workingDirectory(conversationId: string): string {
    return this.resolveCwd(this.loadConversation(conversationId))
  }

  /** Répertoire de travail : le worktree s'il y en a un, sinon la racine du projet. */
  private resolveCwd(conversation: ConversationRow): string {
    return resolveConversationCwd(this.db, conversation)
  }

  private setStatus(conversationId: string, status: ConversationStatus): void {
    const managed = this.runners.get(conversationId)
    if (managed) managed.status = status

    this.db.update(conversations).set({ status }).where(eq(conversations.id, conversationId)).run()
    this.statusBus.emit('status', { conversationId, status, warm: this.isWarm(conversationId) })

    // Le tour vient de se terminer : c'est le seul moment où un message en attente
    // peut partir sans se mêler au contexte du tour précédent.
    if (status === 'idle') void this.flushQueue(conversationId)
  }

  /**
   * Forke une conversation à un point du fil.
   *
   * `throughSeq` est le dernier événement conservé : la branche reprend l'historique
   * jusque-là, et l'agent est ramené au même point côté CLI. Les deux doivent
   * correspondre, sinon le fil afficherait une chose et l'agent se souviendrait d'une
   * autre (invariant I2).
   *
   * Retourne l'identifiant natif de la session branchée, à écrire dans la nouvelle
   * conversation. La copie du journal, elle, appartient à l'appelant : c'est lui qui
   * crée la ligne de conversation.
   */
  async forkSession(conversationId: string, throughSeq: number): Promise<string> {
    const conversation = this.loadConversation(conversationId)
    if (!conversation.agentSessionId) {
      throw new HttpError(
        400,
        'no_agent_session',
        "Cette conversation n'a jamais démarré de session : il n'y a rien à forker.",
      )
    }

    // Côté Claude, le point de coupe est une entrée du transcript, dont l'identifiant
    // ne vit que dans le payload natif conservé à la traduction (invariant I3).
    const raw = this.log.lastRawOfType(conversationId, 'message.completed', throughSeq)
    const uuid = (raw as { uuid?: unknown } | null)?.uuid

    // Côté Codex, la coupe s'exprime en nombre de tours retirés depuis la fin.
    const turns = this.log.countByType(conversationId, 'turn.completed', throughSeq)

    return forkAgentSession({
      agent: conversation.agent,
      agentSessionId: conversation.agentSessionId,
      binary: this.config.agents[conversation.agent].binary,
      cwd: this.resolveCwd(conversation),
      claudeUpToMessageId: typeof uuid === 'string' ? uuid : null,
      codexTurnsToDrop: Math.max(turns.total - turns.kept, 0),
    })
  }

  setNotifier(notifier: ConversationNotifier): void {
    this.notifier = notifier
  }

  /**
   * Notifie le propriétaire, sauf s'il a la conversation sous les yeux.
   *
   * Le socket est le seul signal fiable de présence : un onglet abonné à ce fil reçoit
   * déjà l'événement en direct, lui envoyer en plus une notification système reviendrait
   * à le prévenir de ce qu'il est en train de lire.
   *
   * Rien de ce qui se passe ici ne doit interrompre un agent (invariant I1), d'où
   * l'absence de propagation d'erreur.
   */
  private async notifyIfAway(conversationId: string, event: SillageEvent): Promise<void> {
    const notifier = this.notifier
    const title = NOTIFIABLE[event.type]
    if (!notifier || !title) return

    try {
      const conversation = this.db
        .select({ userId: conversations.userId, title: conversations.title, projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()
      if (!conversation) return
      if (notifier.isWatched(conversationId, conversation.userId)) return

      await notifier.notify(conversation.userId, {
        title,
        body: conversation.title,
        url: `/p/${conversation.projectId}/c/${conversationId}`,
        // Une conversation ne garde qu'une notification affichée : empiler « l'agent a
        // terminé » cinq fois ne dit rien de plus que la dernière.
        tag: conversationId,
      })
    } catch (err) {
      // Une notification perdue n'est pas un incident de conversation, mais l'avaler
      // en silence rendrait tout diagnostic impossible.
      process.stderr.write(
        `[push] notification non emise pour ${conversationId} : ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
    }
  }

  /** Vrai si un process CLI tourne encore pour cette conversation. */
  isWarm(conversationId: string): boolean {
    return this.runners.has(conversationId)
  }

  /** Vrai si un message envoyé maintenant n'atteindrait pas le CLI immédiatement. */
  private isBusy(conversationId: string): boolean {
    const status = this.runners.get(conversationId)?.status
    return status === 'running' || status === 'awaiting_input'
  }

  /**
   * Envoie le premier message en attente, s'il y en a un.
   *
   * Un seul à la fois : `runner.send` repasse le statut à `running`, donc le suivant
   * repartira au `turn.completed` d'après. Les envoyer tous d'un coup les fusionnerait
   * dans un même tour, ce que la file existe justement pour éviter.
   */
  private async flushQueue(conversationId: string): Promise<void> {
    const queue = this.queues.get(conversationId)
    const next = queue?.shift()
    if (!queue || !next) return
    if (queue.length === 0) this.queues.delete(conversationId)

    this.log.append(conversationId, {
      type: 'message.dequeued',
      queueId: next.queueId,
      reason: 'sent',
    })

    try {
      await this.deliver(conversationId, next.text, next.attachments, next.mentions)
    } catch (err) {
      this.log.append(conversationId, {
        type: 'error',
        code: 'queued_message_failed',
        message: `Le message en attente n'a pas pu partir : ${
          err instanceof Error ? err.message : String(err)
        }`,
        recoverable: true,
      })
    }
  }

  /** Retire un message de la file avant qu'il ne parte. */
  cancelQueued(conversationId: string, queueId: string): boolean {
    const queue = this.queues.get(conversationId)
    const index = queue?.findIndex((entry) => entry.queueId === queueId) ?? -1
    if (!queue || index === -1) return false

    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(conversationId)

    this.log.append(conversationId, {
      type: 'message.dequeued',
      queueId,
      reason: 'cancelled',
    })
    return true
  }

  /**
   * Clôt les messages restés en file à l'arrêt du daemon.
   *
   * La file est en mémoire, donc ils sont perdus ; sans cet événement, le fil rejoué
   * les afficherait indéfiniment comme en attente d'un envoi qui n'aura jamais lieu.
   */
  private expireQueuedMessages(conversationId: string): void {
    for (const queueId of this.log.openQueuedMessages(conversationId)) {
      this.log.append(conversationId, { type: 'message.dequeued', queueId, reason: 'expired' })
    }
  }

  private buildContext(conversation: ConversationRow): RunnerContext {
    const conversationId = conversation.id

    return {
      conversationId,
      cwd: this.resolveCwd(conversation),
      config: parseAgentConfig(conversation.config),
      binary: this.config.agents[conversation.agent].binary,
      attachmentsRoot: this.config.paths.attachments,
      resumeSessionId: conversation.agentSessionId,

      emit: (event: SillageEvent, raw?: unknown) => {
        this.log.append(conversationId, event, raw)
        void this.notifyIfAway(conversationId, event)
        if (event.type === 'turn.completed') {
          // Le CLI ne résume la session qu'une fois le tour fini : c'est le premier
          // moment où un titre utile existe.
          void this.adoptSuggestedTitle(conversationId)
          this.db
            .update(conversations)
            .set({
              costUsd: conversation.costUsd + event.costUsd,
              inputTokens: conversation.inputTokens + event.inputTokens,
              outputTokens: conversation.outputTokens + event.outputTokens,
            })
            .where(eq(conversations.id, conversationId))
            .run()
        }
      },

      setStatus: (status) => this.setStatus(conversationId, status),

      setAgentSessionId: (sessionId) => {
        this.db
          .update(conversations)
          .set({ agentSessionId: sessionId })
          .where(eq(conversations.id, conversationId))
          .run()
      },

      openPermissionRequest: (toolName, input) => {
        const id = randomUUID()
        const current = this.db
          .select({ lastSeq: conversations.lastSeq })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get()

        this.db
          .insert(permissionRequests)
          .values({
            id,
            conversationId,
            seq: (current?.lastSeq ?? 0) + 1,
            toolName,
            input: JSON.stringify(input),
            status: 'pending',
            decisionScope: null,
            decidedBy: null,
            createdAt: Date.now(),
            decidedAt: null,
          })
          .run()
        return id
      },

      closePermissionRequest: (requestId, decision) => {
        this.db
          .update(permissionRequests)
          .set({
            status: decision.decision === 'allowed' ? 'allowed' : 'denied',
            decisionScope: decision.scope,
            decidedBy: decision.decidedBy,
            decidedAt: Date.now(),
          })
          .where(eq(permissionRequests.id, requestId))
          .run()
      },
    }
  }

  /**
   * Libère une place quand le plafond de sessions est atteint. On arrête le runner
   * inactif le plus ancien : il repartira en reprise au prochain message, sans que
   * l'utilisateur perde quoi que ce soit. Si tout tourne, on refuse explicitement
   * plutôt que de dépasser le budget mémoire de la machine.
   */
  private async makeRoom(): Promise<void> {
    if (this.runners.size < this.config.limits.maxConcurrentSessions) return

    const idle = [...this.runners.entries()]
      .filter(([, managed]) => managed.status === 'idle' || managed.status === 'interrupted')
      .sort((a, b) => a[1].lastActivity - b[1].lastActivity)

    const oldest = idle[0]
    if (!oldest) {
      throw new HttpError(
        503,
        'session_limit_reached',
        `Les ${this.config.limits.maxConcurrentSessions} sessions simultanées sont occupées. Attends qu'une conversation se termine.`,
      )
    }

    await this.stopRunner(oldest[0])
  }

  private async ensureRunner(conversation: ConversationRow): Promise<AgentRunner> {
    const existing = this.runners.get(conversation.id)
    if (existing) return existing.runner

    await this.makeRoom()

    // Relu depuis la base : agentSessionId a pu être renseigné par un runner précédent.
    const fresh = this.loadConversation(conversation.id)
    const context = this.buildContext(fresh)
    const runner: AgentRunner =
      fresh.agent === 'claude' ? new ClaudeRunner(context) : new CodexRunner(context)

    this.runners.set(conversation.id, {
      runner,
      lastActivity: Date.now(),
      status: 'idle',
      idleTimer: null,
    })

    await runner.start()
    return runner
  }

  private touch(conversationId: string): void {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    managed.lastActivity = Date.now()
    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    managed.idleTimer = setTimeout(
      () => void this.stopRunner(conversationId),
      this.config.limits.sessionIdleTimeoutMin * 60 * 1000,
    )
    // Un runner en veille ne doit pas maintenir le process en vie à lui seul.
    managed.idleTimer.unref()
  }

  /**
   * Résout les chemins mentionnés en chemins absolus, sous le répertoire de travail.
   *
   * La mention arrive du client : un `../` la ferait pointer n'importe où sur le
   * disque du serveur. On rejette au lieu de tronquer, pour que l'agent ne reçoive
   * jamais un fichier différent de celui qui a été désigné.
   */
  private resolveMentions(cwd: string, relativePaths: string[]): OutgoingMention[] {
    return relativePaths.map((relativePath) => resolveMention(cwd, relativePath))
  }

  /**
   * Retient un identifiant de message client, et dit s'il est nouveau (invariant I5).
   *
   * La fenêtre est en mémoire : un doublon ne peut venir que d'un renvoi réseau à
   * quelques secondes d'intervalle, jamais d'un autre process.
   */
  private claimClientMessage(conversationId: string, clientMessageId: string): boolean {
    const key = `${conversationId}:${clientMessageId}`
    const now = Date.now()
    for (const [seen, ts] of this.recentClientMessages) {
      if (now - ts > DEDUPE_TTL_MS) this.recentClientMessages.delete(seen)
    }
    if (this.recentClientMessages.has(key)) return false
    this.recentClientMessages.set(key, now)
    return true
  }

  /**
   * Infléchit le tour en cours plutôt que d'ouvrir le suivant.
   *
   * Retourne false quand ce n'est pas possible : CLI sans équivalent, session arrêtée,
   * ou tour déjà terminé entre l'affichage du bouton et le clic. L'appelant le dit
   * alors franchement, plutôt que de basculer en file d'attente dans le dos de
   * l'utilisateur : les deux gestes ne produisent pas le même résultat.
   */
  async steer(
    conversationId: string,
    clientMessageId: string,
    text: string,
    attachments: OutgoingAttachment[] = [],
    mentions: string[] = [],
  ): Promise<boolean> {
    // Un renvoi réseau ne doit pas infléchir deux fois : le premier a déjà porté.
    if (!this.claimClientMessage(conversationId, clientMessageId)) return true

    const managed = this.runners.get(conversationId)
    if (!managed) return false

    const conversation = this.loadConversation(conversationId)
    const resolved = this.resolveMentions(this.resolveCwd(conversation), mentions)

    const steered = await managed.runner.steer(text, attachments, resolved)
    if (steered) this.touch(conversationId)
    return steered
  }

  async sendMessage(
    conversationId: string,
    clientMessageId: string,
    text: string,
    attachments: OutgoingAttachment[] = [],
    mentions: string[] = [],
  ): Promise<void> {
    if (!this.claimClientMessage(conversationId, clientMessageId)) return

    // Un tour est en cours : le message attend la fin plutôt que d'être poussé au CLI,
    // où il se mêlerait au contexte du tour courant.
    if (this.isBusy(conversationId)) {
      const queueId = randomUUID()
      const queue = this.queues.get(conversationId) ?? []
      queue.push({ queueId, clientMessageId, text, attachments, mentions })
      this.queues.set(conversationId, queue)

      this.log.append(conversationId, {
        type: 'message.queued',
        queueId,
        text,
        attachmentCount: attachments.length,
      })
      this.touch(conversationId)
      return
    }

    await this.deliver(conversationId, text, attachments, mentions)
  }

  /** Transmet réellement le message au CLI, en démarrant le runner si besoin. */
  private async deliver(
    conversationId: string,
    text: string,
    attachments: OutgoingAttachment[],
    mentions: string[],
  ): Promise<void> {
    const conversation = this.loadConversation(conversationId)
    // Résolu avant de démarrer le runner : une mention invalide doit faire échouer
    // l'envoi, pas laisser une session lancée avec un message perdu.
    const resolved = this.resolveMentions(this.resolveCwd(conversation), mentions)

    const runner = await this.ensureRunner(conversation)
    await runner.send(text, attachments, resolved)
    this.touch(conversationId)
  }

  /**
   * Compacte le contexte de la conversation.
   *
   * Un runner arrêté est relancé : compacter demande la session chargée, et la reprise
   * est de toute façon ce qui se passerait au message suivant.
   */
  async compact(conversationId: string): Promise<boolean> {
    if (this.isBusy(conversationId)) {
      throw new HttpError(
        409,
        'conversation_busy',
        'Un tour est en cours : attends qu\'il se termine pour compacter.',
      )
    }

    const conversation = this.loadConversation(conversationId)
    const runner = await this.ensureRunner(conversation)
    const compacted = await runner.compact()
    if (compacted) this.touch(conversationId)
    return compacted
  }

  async interrupt(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) {
      this.setStatus(conversationId, 'idle')
      return
    }
    await managed.runner.interrupt()
  }

  resolvePermission(conversationId: string, requestId: string, decision: PermissionDecision): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const resolved = managed.runner.resolvePermission(requestId, decision)
    if (resolved) this.touch(conversationId)
    return resolved
  }

  answerQuestion(conversationId: string, requestId: string, answer: QuestionAnswer): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const answered = managed.runner.answerQuestion(requestId, answer)
    if (answered) this.touch(conversationId)
    return answered
  }

  resolveElicitation(
    conversationId: string,
    requestId: string,
    answer: ElicitationAnswer,
  ): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const resolved = managed.runner.resolveElicitation(requestId, answer)
    if (resolved) this.touch(conversationId)
    return resolved
  }

  reviewPlan(conversationId: string, requestId: string, review: PlanReview): boolean {
    const managed = this.runners.get(conversationId)
    if (!managed) return false
    const reviewed = managed.runner.reviewPlan(requestId, review)
    if (reviewed) this.touch(conversationId)
    return reviewed
  }

  hasPendingPermission(conversationId: string, requestId: string): boolean {
    const row = this.db
      .select({ id: permissionRequests.id })
      .from(permissionRequests)
      .where(
        and(eq(permissionRequests.id, requestId), eq(permissionRequests.conversationId, conversationId)),
      )
      .get()
    return row !== undefined
  }

  /**
   * Reprend le titre proposé par le CLI, tant que l'utilisateur n'a pas renommé
   * lui-même. Évite le « Nouvelle conversation » générique sans jamais écraser un
   * choix explicite.
   */
  private async adoptSuggestedTitle(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    const conversation = this.db
      .select({ title: conversations.title, titleSetByUser: conversations.titleSetByUser })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!conversation || conversation.titleSetByUser) return

    const title = await managed.runner.suggestedTitle()
    if (!title || title === conversation.title) return

    this.db
      .update(conversations)
      .set({ title })
      .where(eq(conversations.id, conversationId))
      .run()
    this.statusBus.emit('title', { conversationId, title })
  }

  /**
   * Applique la configuration relue en base. Le SDK sait changer modèle, effort et
   * mode de permission à chaud, donc la session garde son contexte ; on ne retombe
   * sur l'arrêt du runner (et la reprise au message suivant) que si le CLI refuse.
   */
  async reloadConfig(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    const conversation = this.loadConversation(conversationId)
    const config = parseAgentConfig(conversation.config)

    let applied = false
    let reason: string | null = null
    try {
      applied = await managed.runner.applyConfig(config)
      if (!applied) reason = 'le CLI ne gère pas ce changement à chaud'
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err)
    }
    if (applied) return

    // Le repli est visible dans le fil plutôt qu'avalé : redémarrer la session a un
    // coût réel (contexte rechargé) et l'utilisateur doit savoir pourquoi.
    await this.stopRunner(conversationId)
    this.log.append(conversationId, {
      type: 'error',
      code: 'config_applied_by_restart',
      message: `Réglages appliqués en relançant la session (${reason}).`,
      recoverable: true,
    })
    this.setStatus(conversationId, 'idle')
  }

  /**
   * Arrête le runner d'une conversation, s'il tourne.
   *
   * Utilisé par la resynchronisation depuis le transcript CLI : un process encore
   * chaud garde en mémoire un contexte qui ignore les tours faits au CLI, alors
   * qu'une reprise repart du fichier, qui a tout.
   */
  async releaseRunner(conversationId: string): Promise<void> {
    await this.stopRunner(conversationId)
  }

  private async stopRunner(conversationId: string): Promise<void> {
    const managed = this.runners.get(conversationId)
    if (!managed) return

    // Les messages en attente ne partiront pas : le runner s'arrête. Les laisser en
    // file les rendrait invisiblement perdus au prochain message.
    for (const entry of this.queues.get(conversationId) ?? []) {
      this.log.append(conversationId, {
        type: 'message.dequeued',
        queueId: entry.queueId,
        reason: 'expired',
      })
    }
    this.queues.delete(conversationId)

    this.runners.delete(conversationId)
    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    await managed.runner.stop()

    // Le statut ne bouge pas quand un runner expire : sans cette diffusion, l'UI
    // continuerait d'annoncer une session chaude qui n'existe plus.
    this.statusBus.emit('status', {
      conversationId,
      status: managed.status,
      warm: false,
    })
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((id) => this.stopRunner(id)))
  }

  activeCount(): number {
    return this.runners.size
  }
}
