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
  BASELINE_DECISION_SOURCES,
  decisionSourceKindSchema,
  type DecisionDto,
  type DecisionSourceKind,
} from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { HttpError } from '../http/errors.js'
import type { Notifications } from '../notifications/dispatcher.js'
import type { SessionManager } from '../sessions/session-manager.js'

/** Minute precision suffices for deadlines and delayed deliveries. */
const TICK_MS = 30_000
const HOUR_MS = 3_600_000

/** Agent-facing rejections returned verbatim. */
export class DecisionRefusal extends Error {}

/** Autonomous session source: what launched it and what it permits. */
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

/** Decisions requested by autonomous sessions. Human-opened sessions ask in conversations with someone reading; scheduled tasks, automations and board maintenance have nobody present. They deposit requests without blocking and finish or continue turns; answers return as messages, surviving restarts unlike native CLI requests that die with processes. */
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

  /** Autonomous conversation source, or null for human-opened sessions. Read task association from conversations or maintenance association from tracked issues; agents cannot self-declare it. */
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

  // --- Agent actions (through the MCP server and agent_requests) ----------------

  async request(requester: ConversationRow, payload: Record<string, unknown>): Promise<string> {
    const source = this.sourceOf(requester)
    if (!source) {
      throw new DecisionRefusal(
        'This tool is only for autonomous sessions (scheduled tasks, automations, board maintenance). A person is reading this thread: ask your question in your reply.',
      )
    }
    if (!source.enabled) {
      throw new DecisionRefusal(`“${source.label}” does not allow sessions to request decisions. Decide according to your instructions.`)
    }

    const question = typeof payload.question === 'string' ? payload.question.trim() : ''
    if (!question) throw new DecisionRefusal('The `question` parameter is required.')
    if (question.length > MAX_DECISION_QUESTION_CHARS) {
      throw new DecisionRefusal(`Question too long (maximum ${MAX_DECISION_QUESTION_CHARS} characters): put details in \`context\`.`)
    }
    const context = typeof payload.context === 'string' ? payload.context.trim() : ''
    if (context.length > MAX_DECISION_CONTEXT_CHARS) {
      throw new DecisionRefusal(`Context too long (maximum ${MAX_DECISION_CONTEXT_CHARS} characters).`)
    }
    const options = Array.isArray(payload.options)
      ? [...new Set(payload.options.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))]
      : []
    if (options.length > MAX_DECISION_OPTIONS) throw new DecisionRefusal(`At most ${MAX_DECISION_OPTIONS} choices.`)
    if (options.some((option) => option.length > MAX_DECISION_OPTION_CHARS)) {
      throw new DecisionRefusal(`Each choice must fit within ${MAX_DECISION_OPTION_CHARS} characters.`)
    }
    const fallback = typeof payload.default === 'string' && payload.default.trim() ? payload.default.trim() : null
    if (fallback && !options.includes(fallback)) {
      throw new DecisionRefusal('`default` must exactly match one of `options`.')
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
        `A request is already awaiting an answer (“${pending.question}”): only one at a time. Wait for it or withdraw it with withdraw_decision if it no longer applies.`,
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
      worktreePath: null,
      createdAt: now,
    }
    this.ctx.db.insert(decisions).values(row).run()
    await this.announce(row)

    return [
      'The request was submitted: the user sees it in Decisions and receives a notification.',
      `Do not wait: end your turn or continue independent work. The reply will arrive as a message by ${stamp(row.expiresAt)}; ${fallback ? `if nobody replies, Sillage will answer “${fallback}”` : 'if nobody replies, Sillage will tell you'}.`,
      'If it no longer applies before a reply arrives, withdraw it with withdraw_decision.',
    ].join('\n')
  }

  withdraw(requester: ConversationRow, payload: Record<string, unknown>): string {
    const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 500) : ''
    const pending = this.ctx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.conversationId, requester.id), eq(decisions.status, 'pending')))
      .get()
    if (!pending) throw new DecisionRefusal('No pending decision request for this session.')
    this.close(pending, { status: 'withdrawn', withdrawnReason: reason || null, deliveredAt: Date.now() })
    return `Request withdrawn (“${pending.question}”).`
  }

  // --- User actions ------------------------------------------------------

  /** `sources`: kinds the client can display (see `requestedDecisionSources`). Defaults to all like `get`; only routes restrict it. */
  list(
    userId: string,
    status: 'pending' | 'all',
    sources: readonly DecisionSourceKind[] = decisionSourceKindSchema.options,
    limit = 100,
  ): DecisionDto[] {
    const rows = this.ctx.db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.userId, userId),
          inArray(decisions.sourceKind, [...sources]),
          status === 'pending' ? eq(decisions.status, 'pending') : undefined,
        ),
      )
      .orderBy(status === 'pending' ? decisions.createdAt : desc(decisions.createdAt))
      .limit(limit)
      .all()
    return this.toDtos(rows)
  }

  /** All sources by default; only display clients restrict lists. */
  get(userId: string, id: string, sources: readonly DecisionSourceKind[] = decisionSourceKindSchema.options): DecisionDto {
    const row = this.ctx.db.select().from(decisions).where(eq(decisions.id, id)).get()
    if (!row || row.userId !== userId || !sources.includes(row.sourceKind)) {
      throw new HttpError(404, 'decision_not_found', 'Decision not found.')
    }
    return this.toDtos([row])[0]!
  }

  pendingCount(userId: string): number {
    return this.ctx.db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.userId, userId), eq(decisions.status, 'pending'), inArray(decisions.sourceKind, [...BASELINE_DECISION_SOURCES])))
      .all().length
  }

  async answer(userId: string, id: string, body: { option: string | null; text: string }): Promise<DecisionDto> {
    const row = this.ctx.db.select().from(decisions).where(eq(decisions.id, id)).get()
    if (!row || row.userId !== userId) throw new HttpError(404, 'decision_not_found', 'Decision not found.')
    if (row.sourceKind === 'worktree' && row.status === 'pending') this.retireWorktreeProposal(row)
    if (row.status !== 'pending' || row.sourceKind === 'worktree') throw new HttpError(409, 'decision_closed', 'This decision is no longer pending.')
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

  /** Old proposals remain readable without actions or agent restarts. */
  private retireWorktreeProposal(row: DecisionRow): void {
    this.close(row, {
      status: 'withdrawn',
      withdrawnReason: 'Le nettoyage se fait désormais depuis la conversation ou la vue Chantiers.',
      deliveredAt: Date.now(),
    })
  }

  // --- Processing passes ---------------------------------------------------------------------

  /** Handles deadlines, obsolete requests (archived/deleted sessions) and pending deliveries, such as daemon restarts between answering and delivery. */
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
        // Older versions deposited cleanup proposals here: remove them at startup
        // without touching trees or agent requests.
        if (row.sourceKind === 'worktree') {
          this.retireWorktreeProposal(row)
          continue
        }
        const archivedAt = alive.get(row.conversationId)
        if (archivedAt === undefined || archivedAt !== null) {
          // Archiving puts sessions away; their requests no longer await anyone.
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

  /** Answers or deadlines become session messages, waking agents. */
  private async deliver(row: DecisionRow): Promise<void> {
    if (row.sourceKind === 'worktree') {
      this.ctx.db.update(decisions).set({ deliveredAt: Date.now() }).where(eq(decisions.id, row.id)).run()
      return
    }
    const exists = this.ctx.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, row.conversationId)).get()
    if (exists) {
      try {
        await this.sessions.sendMessage(row.conversationId, randomUUID(), this.message(row))
      } catch (err) {
        // Retry delivery next pass; decisions themselves are already resolved.
        this.logger?.warn({ err, decision: row.id }, 'réponse de décision non remise')
        return
      }
    }
    this.ctx.db.update(decisions).set({ deliveredAt: Date.now() }).where(eq(decisions.id, row.id)).run()
  }

  private message(row: DecisionRow): string {
    if (row.status === 'expired') {
      return [
        '[Sillage — your decision request expired without a reply]',
        '',
        `Question : « ${row.question} »`,
        row.defaultOption
          ? `Default answer applied as you specified: “${row.defaultOption}”.`
          : 'Nobody replied before the deadline, and you had not supplied a default choice.',
      ].join('\n')
    }
    const by = row.answeredBy ? this.ctx.db.select({ name: users.displayName }).from(users).where(eq(users.id, row.answeredBy)).get()?.name : null
    return [
      '[Sillage — reply to your decision request]',
      '',
      `Question : « ${row.question} »`,
      row.answerOption ? `Answer: “${row.answerOption}”` : null,
      row.answerText ? `${row.answerOption ? 'Details' : 'Answer'}: ${row.answerText}` : null,
      by ? `Answered by ${by}.` : null,
    ]
      .filter((line) => line !== null)
      .join('\n')
  }

  /** Maintenance-session decisions also appear in card threads. */
  private noteOnCard(row: DecisionRow): void {
    const answer =
      row.status === 'expired'
        ? row.defaultOption
          ? `expired, “${row.defaultOption}” applied by default`
          : 'expired without a reply'
        : [row.answerOption ? `« ${row.answerOption} »` : null, row.answerText].filter(Boolean).join(' — ')
    this.ctx.db
      .insert(cardNotes)
      .values({
        id: randomUUID(),
        cardId: row.cardId!,
        conversationId: row.conversationId,
        userId: row.status === 'answered' ? row.answeredBy : null,
        body: `Decision: ${row.question}\n→ ${answer}`,
        createdAt: Date.now(),
      })
      .run()
  }

  /** Notifications and toasts announce pending decisions, the purpose of notifying users. */
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
          sourceKind: row.sourceKind,
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
    // Card numbers, not issue numbers, open board cards.
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
        worktreePath: row.worktreePath,
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
