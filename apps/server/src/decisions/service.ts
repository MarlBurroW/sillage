import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  boardLinks,
  cardIssues,
  cardNotes,
  cards,
  conversations,
  decisions,
  projects,
  scheduledTasks,
  users,
  type ConversationRow,
  type DecisionRow,
} from '@sillage/db'
import {
  MAX_DECISION_CONTEXT_CHARS,
  MAX_DECISION_OPTION_CHARS,
  MAX_DECISION_OPTIONS,
  MAX_DECISION_QUESTION_CHARS,
  type DecisionDto,
  type DecisionSourceKind,
} from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { HttpError } from '../http/errors.js'
import type { Notifications } from '../notifications/dispatcher.js'
import type { SessionManager } from '../sessions/session-manager.js'

/** Échéances et remises en retard : la précision de la minute suffit. */
const TICK_MS = 30_000
const HOUR_MS = 3_600_000

/** Refus adressé à l'agent : le texte lui est rendu tel quel. */
export class DecisionRefusal extends Error {}

/** La source autonome d'une session : ce qui l'a ouverte, et ce qu'elle permet. */
export interface DecisionSource {
  kind: DecisionSourceKind
  label: string
  userId: string
  taskId: string | null
  cardId: string | null
  enabled: boolean
  maxHours: number
}

function parseOptions(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * Les décisions demandées par les sessions autonomes.
 *
 * Une session ouverte par une personne pose ses questions dans le fil, où quelqu'un les
 * lit ; une tâche planifiée, une automatisation ou la maintenance du board n'a personne
 * en face. Elle dépose ici sa demande sans se bloquer, termine son tour ou continue, et
 * la réponse lui revient en message : c'est ce qui survit aux redémarrages, là où une
 * demande native du CLI meurt avec son process.
 */
export class DecisionService {
  private timer: NodeJS.Timeout | null = null
  private logger: FastifyBaseLogger | null = null
  private ticking = false

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: Pick<SessionManager, 'sendMessage'>,
    private readonly notifications: Pick<Notifications, 'dispatch' | 'decisionsChanged'>,
  ) {}

  start(logger: FastifyBaseLogger): void {
    this.logger = logger
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * La source autonome d'une conversation, ou null pour une session ouverte par une
   * personne. Lue sur la conversation elle-même (tâche) ou sur l'issue qu'elle suit
   * (maintenance) : rien qu'un agent puisse déclarer de lui-même.
   */
  sourceOf(conversation: Pick<ConversationRow, 'id' | 'scheduleId' | 'projectId'>): DecisionSource | null {
    if (conversation.scheduleId) {
      const task = this.ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, conversation.scheduleId)).get()
      if (!task) return null
      const webhook = (JSON.parse(task.cadence) as { kind?: string }).kind === 'webhook'
      return {
        kind: webhook ? 'webhook' : 'schedule',
        label: task.name,
        userId: task.userId,
        taskId: task.id,
        cardId: null,
        enabled: task.decisionsEnabled,
        maxHours: task.decisionMaxHours,
      }
    }
    const issue = this.ctx.db
      .select({ cardId: cardIssues.cardId, number: cardIssues.number, projectId: cardIssues.projectId })
      .from(cardIssues)
      .where(eq(cardIssues.responderId, conversation.id))
      .get()
    if (!issue) return null
    const link = this.ctx.db.select().from(boardLinks).where(eq(boardLinks.projectId, issue.projectId)).get()
    if (!link) return null
    return {
      kind: 'board',
      label: `Issue #${issue.number}`,
      userId: link.userId,
      taskId: null,
      cardId: issue.cardId,
      enabled: link.decisionsEnabled,
      maxHours: link.decisionMaxHours,
    }
  }

  // --- Gestes de l'agent (par le serveur MCP, via `agent_requests`) ----------------

  async request(requester: ConversationRow, payload: Record<string, unknown>): Promise<string> {
    const source = this.sourceOf(requester)
    if (!source) {
      throw new DecisionRefusal(
        "Cet outil ne sert qu'aux sessions autonomes (tâche planifiée, automatisation, maintenance du board). Ici, une personne lit le fil : pose ta question dans ta réponse.",
      )
    }
    if (!source.enabled) {
      throw new DecisionRefusal(`« ${source.label} » n'autorise pas ses sessions à demander une décision. Décide selon tes instructions.`)
    }

    const question = typeof payload.question === 'string' ? payload.question.trim() : ''
    if (!question) throw new DecisionRefusal('Le paramètre `question` est requis.')
    if (question.length > MAX_DECISION_QUESTION_CHARS) {
      throw new DecisionRefusal(`Question trop longue (${MAX_DECISION_QUESTION_CHARS} caractères au plus) : mets le détail dans \`context\`.`)
    }
    const context = typeof payload.context === 'string' ? payload.context.trim() : ''
    if (context.length > MAX_DECISION_CONTEXT_CHARS) {
      throw new DecisionRefusal(`Contexte trop long (${MAX_DECISION_CONTEXT_CHARS} caractères au plus).`)
    }
    const options = Array.isArray(payload.options)
      ? [...new Set(payload.options.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))]
      : []
    if (options.length > MAX_DECISION_OPTIONS) throw new DecisionRefusal(`${MAX_DECISION_OPTIONS} choix au plus.`)
    if (options.some((option) => option.length > MAX_DECISION_OPTION_CHARS)) {
      throw new DecisionRefusal(`Un choix tient en ${MAX_DECISION_OPTION_CHARS} caractères au plus.`)
    }
    const fallback = typeof payload.default === 'string' && payload.default.trim() ? payload.default.trim() : null
    if (fallback && !options.includes(fallback)) {
      throw new DecisionRefusal('`default` doit reprendre exactement l’un des `options`.')
    }
    const asked = typeof payload.expires_in_hours === 'number' && Number.isFinite(payload.expires_in_hours) ? payload.expires_in_hours : source.maxHours
    const hours = Math.min(Math.max(asked, 0.25), source.maxHours)

    const pending = this.ctx.db
      .select({ id: decisions.id, question: decisions.question })
      .from(decisions)
      .where(and(eq(decisions.conversationId, requester.id), eq(decisions.status, 'pending')))
      .get()
    if (pending) {
      throw new DecisionRefusal(
        `Une demande attend déjà sa réponse (« ${pending.question} ») : une seule à la fois. Attends-la, ou retire-la avec withdraw_decision si elle n'a plus lieu d'être.`,
      )
    }

    const now = Date.now()
    const row: DecisionRow = {
      id: randomUUID(),
      projectId: requester.projectId,
      conversationId: requester.id,
      userId: source.userId,
      sourceKind: source.kind,
      sourceLabel: source.label,
      taskId: source.taskId,
      cardId: source.cardId,
      question,
      context,
      options: JSON.stringify(options),
      defaultOption: fallback,
      expiresAt: now + hours * HOUR_MS,
      status: 'pending',
      answerOption: null,
      answerText: null,
      answeredBy: null,
      resolvedAt: null,
      withdrawnReason: null,
      deliveredAt: null,
      createdAt: now,
    }
    this.ctx.db.insert(decisions).values(row).run()
    await this.announce(row)

    return [
      `Demande déposée : l'utilisateur la voit dans « À décider » et reçoit une notification.`,
      `Ne l'attends pas : termine ton tour, ou continue ce qui n'en dépend pas. La réponse t'arrivera en message, au plus tard le ${stamp(row.expiresAt)} ; ${fallback ? `sans réponse d'ici là, Sillage répondra « ${fallback} » à sa place` : "sans réponse d'ici là, Sillage te le dira"}.`,
      'Si elle n’a plus lieu d’être avant la réponse, retire-la avec withdraw_decision.',
    ].join('\n')
  }

  withdraw(requester: ConversationRow, payload: Record<string, unknown>): string {
    const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 500) : ''
    const pending = this.ctx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.conversationId, requester.id), eq(decisions.status, 'pending')))
      .get()
    if (!pending) throw new DecisionRefusal('Aucune demande de décision en attente pour cette session.')
    this.close(pending, { status: 'withdrawn', withdrawnReason: reason || null, deliveredAt: Date.now() })
    return `Demande retirée (« ${pending.question} »).`
  }

  // --- Gestes de l'utilisateur ------------------------------------------------------

  list(userId: string, status: 'pending' | 'all', limit = 100): DecisionDto[] {
    const rows = this.ctx.db
      .select()
      .from(decisions)
      .where(status === 'pending' ? and(eq(decisions.userId, userId), eq(decisions.status, 'pending')) : eq(decisions.userId, userId))
      .orderBy(status === 'pending' ? decisions.createdAt : desc(decisions.createdAt))
      .limit(limit)
      .all()
    return this.toDtos(rows)
  }

  get(userId: string, id: string): DecisionDto {
    const row = this.ctx.db.select().from(decisions).where(eq(decisions.id, id)).get()
    if (!row || row.userId !== userId) throw new HttpError(404, 'decision_not_found', 'Decision not found.')
    return this.toDtos([row])[0]!
  }

  pendingCount(userId: string): number {
    return this.ctx.db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.userId, userId), eq(decisions.status, 'pending')))
      .all().length
  }

  async answer(userId: string, id: string, body: { option: string | null; text: string }): Promise<DecisionDto> {
    const row = this.ctx.db.select().from(decisions).where(eq(decisions.id, id)).get()
    if (!row || row.userId !== userId) throw new HttpError(404, 'decision_not_found', 'Decision not found.')
    if (row.status !== 'pending') throw new HttpError(409, 'decision_closed', 'This decision is no longer pending.')
    if (body.option !== null && !parseOptions(row.options).includes(body.option)) {
      throw new HttpError(400, 'decision_unknown_option', 'This option was not offered.')
    }
    const closed = this.close(row, {
      status: 'answered',
      answerOption: body.option,
      answerText: body.text || null,
      answeredBy: userId,
    })
    await this.deliver(closed)
    return this.get(userId, id)
  }

  // --- Passages ---------------------------------------------------------------------

  /**
   * Échéances, demandes devenues caduques (session archivée ou supprimée) et remises
   * restées en souffrance, par exemple parce que le daemon a redémarré entre la réponse
   * et la remise.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const pending = this.ctx.db.select().from(decisions).where(eq(decisions.status, 'pending')).all()
      const ids = [...new Set(pending.map((row) => row.conversationId))]
      const alive = new Map(
        ids.length === 0
          ? []
          : this.ctx.db
              .select({ id: conversations.id, archivedAt: conversations.archivedAt })
              .from(conversations)
              .where(inArray(conversations.id, ids))
              .all()
              .map((row) => [row.id, row.archivedAt]),
      )
      for (const row of pending) {
        const archivedAt = alive.get(row.conversationId)
        if (archivedAt === undefined || archivedAt !== null) {
          // Archiver une session, c'est la ranger : sa demande n'attend plus personne.
          this.close(row, { status: 'withdrawn', withdrawnReason: null, deliveredAt: now })
        } else if (row.expiresAt <= now) {
          await this.deliver(this.close(row, { status: 'expired' }))
        }
      }
      const late = this.ctx.db
        .select()
        .from(decisions)
        .where(and(or(eq(decisions.status, 'answered'), eq(decisions.status, 'expired')), isNull(decisions.deliveredAt), isNotNull(decisions.resolvedAt), lte(decisions.resolvedAt, now - TICK_MS)))
        .all()
      for (const row of late) await this.deliver(row)
    } catch (err) {
      this.logger?.warn({ err }, 'passage des décisions en échec')
    } finally {
      this.ticking = false
    }
  }

  private close(row: DecisionRow, patch: Partial<DecisionRow> & { status: DecisionRow['status'] }): DecisionRow {
    const closed = { ...row, ...patch, resolvedAt: Date.now() }
    this.ctx.db.update(decisions).set({ ...patch, resolvedAt: closed.resolvedAt }).where(eq(decisions.id, row.id)).run()
    if (closed.cardId && (closed.status === 'answered' || closed.status === 'expired')) this.noteOnCard(closed)
    this.notifications.decisionsChanged(row.userId)
    return closed
  }

  /** La réponse, ou l'échéance, part à la session : c'est ce message qui la relance. */
  private async deliver(row: DecisionRow): Promise<void> {
    const exists = this.ctx.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, row.conversationId)).get()
    if (exists) {
      try {
        await this.sessions.sendMessage(row.conversationId, randomUUID(), this.message(row))
      } catch (err) {
        // Le passage suivant réessaie ; la décision, elle, est tranchée.
        this.logger?.warn({ err, decision: row.id }, 'réponse de décision non remise')
        return
      }
    }
    this.ctx.db.update(decisions).set({ deliveredAt: Date.now() }).where(eq(decisions.id, row.id)).run()
  }

  private message(row: DecisionRow): string {
    if (row.status === 'expired') {
      return [
        '[Sillage — ta demande de décision a expiré sans réponse]',
        '',
        `Question : « ${row.question} »`,
        row.defaultOption
          ? `Réponse appliquée par défaut, comme tu l'avais prévu : « ${row.defaultOption} ».`
          : "Personne n'a répondu dans le délai, et tu n'avais pas donné de choix par défaut.",
      ].join('\n')
    }
    const by = row.answeredBy ? this.ctx.db.select({ name: users.displayName }).from(users).where(eq(users.id, row.answeredBy)).get()?.name : null
    return [
      '[Sillage — réponse à ta demande de décision]',
      '',
      `Question : « ${row.question} »`,
      row.answerOption ? `Réponse : « ${row.answerOption} »` : null,
      row.answerText ? `${row.answerOption ? 'Précision' : 'Réponse'} : ${row.answerText}` : null,
      by ? `Répondu par ${by}.` : null,
    ]
      .filter((line) => line !== null)
      .join('\n')
  }

  /** Pour une session de maintenance, la décision s'inscrit aussi dans le fil de la carte. */
  private noteOnCard(row: DecisionRow): void {
    const answer =
      row.status === 'expired'
        ? row.defaultOption
          ? `expirée, « ${row.defaultOption} » appliqué par défaut`
          : 'expirée sans réponse'
        : [row.answerOption ? `« ${row.answerOption} »` : null, row.answerText].filter(Boolean).join(' — ')
    this.ctx.db
      .insert(cardNotes)
      .values({
        id: randomUUID(),
        cardId: row.cardId!,
        conversationId: row.conversationId,
        userId: row.status === 'answered' ? row.answeredBy : null,
        body: `Décision : ${row.question}\n→ ${answer}`,
        createdAt: Date.now(),
      })
      .run()
  }

  /** Notification et toast : une décision attend, c'est tout l'intérêt de la prévenir. */
  private async announce(row: DecisionRow): Promise<void> {
    const project = this.ctx.db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId)).get()
    this.notifications.decisionsChanged(row.userId)
    await this.notifications
      .dispatch(row.userId, {
        kind: 'decision',
        push: {
          title: 'Décision à prendre',
          body: `${row.sourceLabel} — ${row.question}`,
          url: `/decisions?open=${row.id}`,
          tag: `decision-${row.id}`,
          kind: 'decision',
          badge: this.pendingCount(row.userId),
        },
        toast: {
          kind: 'decision',
          decisionId: row.id,
          question: row.question,
          sourceLabel: row.sourceLabel,
          projectName: project?.name ?? '',
        },
      })
      .catch((err: unknown) => this.logger?.warn({ err, decision: row.id }, 'notification de décision non émise'))
  }

  private toDtos(rows: DecisionRow[]): DecisionDto[] {
    if (rows.length === 0) return []
    const projectNames = new Map(
      this.ctx.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, [...new Set(rows.map((row) => row.projectId))]))
        .all()
        .map((row) => [row.id, row.name]),
    )
    const titles = new Map(
      this.ctx.db
        .select({ id: conversations.id, title: conversations.title })
        .from(conversations)
        .where(inArray(conversations.id, [...new Set(rows.map((row) => row.conversationId))]))
        .all()
        .map((row) => [row.id, row.title]),
    )
    const answerers = [...new Set(rows.flatMap((row) => (row.answeredBy ? [row.answeredBy] : [])))]
    const names = new Map(
      answerers.length === 0
        ? []
        : this.ctx.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, answerers)).all().map((row) => [row.id, row.name]),
    )
    // Le numéro de la carte, pas celui de l'issue : c'est lui qui ouvre la carte au board.
    const cardNumbers = new Map(
      this.ctx.db
        .select({ cardId: cards.id, number: cards.number })
        .from(cards)
        .where(inArray(cards.id, rows.flatMap((row) => (row.cardId ? [row.cardId] : ['']))))
        .all()
        .map((row) => [row.cardId, row.number]),
    )
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      projectName: projectNames.get(row.projectId) ?? '',
      conversationId: row.conversationId,
      conversationTitle: titles.get(row.conversationId) ?? null,
      source: {
        kind: row.sourceKind,
        label: row.sourceLabel,
        taskId: row.taskId,
        cardNumber: row.cardId ? (cardNumbers.get(row.cardId) ?? null) : null,
      },
      question: row.question,
      context: row.context,
      options: parseOptions(row.options),
      defaultOption: row.defaultOption,
      expiresAt: row.expiresAt,
      status: row.status,
      answer:
        row.status === 'answered' || row.status === 'expired'
          ? {
              option: row.status === 'expired' ? row.defaultOption : row.answerOption,
              text: row.answerText,
              byName: row.answeredBy ? (names.get(row.answeredBy) ?? null) : null,
              at: row.resolvedAt ?? row.createdAt,
            }
          : null,
      withdrawnReason: row.withdrawnReason,
      createdAt: row.createdAt,
    }))
  }
}
