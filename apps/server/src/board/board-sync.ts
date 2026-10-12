import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull, isNull, lt, max, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import {
  attachments,
  boardLinks,
  cardIssues,
  cardNotes,
  cards,
  conversations,
  writeTransaction,
  type BoardLinkRow,
  type CardIssueRow,
  type CardRow,
} from '@sillage/db'
import { CARD_TITLE_MAX, findSessionMarkers, sessionMarker, type AgentKind, type CardColumn } from '@sillage/protocol'
import type { GitCredentialStore } from '../git-credentials/store.js'
import type { AppContext } from '../http/context.js'
import { HttpError } from '../http/errors.js'
import { createCard, syncCardReferences } from '../http/routes/cards.js'
import { columnMatches, columnStateChanged, desiredState, impliedColumn, type RemoteState } from './columns.js'
import type { MaintenanceEvent, Responder } from './responder.js'
import {
  BoardGitHubError,
  GitHubIssues,
  commentIssueNumber,
  labelNames,
  type FetchLike,
  type GitHubComment,
  type GitHubIssue,
} from './github-issues.js'

/** Les changements faits dans Sillage partent vite ; la lecture de GitHub, plus rarement. */
const TICK_MS = 15_000
const PULL_EVERY_MS = 2 * 60_000
/**
 * Recul pris sur le curseur : `since` compare à l'horloge de GitHub, pas à la nôtre.
 * Relire une minute de trop ne coûte rien, toutes les écritures étant idempotentes.
 */
const CURSOR_MARGIN_MS = 60_000
const DAY_MS = 86_400_000

/**
 * Ce que Sillage ajoute à un texte qu'un agent publie : la signature si le board assume
 * l'IA, puis la marque de session, invisible. C'est la marque, et elle seule, qui fait
 * que ce texte n'ouvrira pas de session de maintenance en revenant de GitHub.
 */
export function publicationTail(link: Pick<BoardLinkRow, 'identity' | 'signature'>, conversationId: string): string {
  const signature = link.identity === 'ai' ? link.signature.trim() : ''
  return signature ? `${signature}\n${sessionMarker(conversationId)}` : sessionMarker(conversationId)
}

/**
 * Le corps d'une issue sans la marque de session, ni la signature du board quand elle la
 * précède : les deux sont gardées à part pour être remises. La carte montre le texte, et
 * le modifier ici ne doit pas effacer de GitHub ce qui dit d'où il vient.
 */
export function splitMarker(body: string | null, signature = ''): { body: string; marker: string | null } {
  const text = (body ?? '').replace(/\r\n/g, '\n')
  const [first] = findSessionMarkers(text)
  if (!first) return { body: text, marker: null }
  let rest = text.replace(/\n*<!--\s*sillage:session=[0-9a-f-]{36}\s*-->/gi, '').trimEnd()
  const signed = signature.trim() !== '' && rest.endsWith(signature.trim())
  if (signed) rest = rest.slice(0, rest.length - signature.trim().length).trimEnd()
  return { body: rest, marker: signed ? `${signature.trim()}\n${sessionMarker(first)}` : sessionMarker(first) }
}

function remoteOf(row: Pick<CardIssueRow, 'state' | 'stateReason' | 'labels'>): RemoteState {
  return { state: row.state, stateReason: row.stateReason, labels: parseLabels(row.labels) }
}

function issueRemote(issue: GitHubIssue): RemoteState {
  return { state: issue.state, stateReason: issue.state_reason, labels: labelNames(issue) }
}

function parseLabels(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

export function parseHidden(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is number => Number.isInteger(entry)) : []
  } catch {
    return []
  }
}

/**
 * Un titre GitHub peut dépasser ce qu'une carte accepte. La table garde la version
 * coupée, celle de la carte : comparer l'entière à la coupée la ferait renvoyer, tronquée,
 * à chaque passage.
 */
const cardTitle = (title: string) => title.slice(0, CARD_TITLE_MAX)

/** Ce que la table garde d'une issue lue sur GitHub. */
function issueColumns(issue: GitHubIssue, signature: string) {
  const { body, marker } = splitMarker(issue.body, signature)
  return {
    url: issue.html_url,
    author: issue.user?.login ?? null,
    title: cardTitle(issue.title),
    body,
    marker,
    state: issue.state,
    stateReason: issue.state_reason,
    labels: JSON.stringify(labelNames(issue)),
    remoteUpdatedAt: issue.updated_at,
    closedAt: issue.closed_at ? Date.parse(issue.closed_at) : null,
  }
}

/**
 * Une carte porte du travail local : une session, un fichier, une note écrite dans
 * Sillage. C'est ce qui la fait rester quand son issue sort du board.
 */
export function hasLocalWork(db: AppContext['db'], cardId: string): boolean {
  const session = db.select({ id: conversations.id }).from(conversations).where(eq(conversations.cardId, cardId)).limit(1).get()
  if (session) return true
  const file = db.select({ id: attachments.id }).from(attachments).where(eq(attachments.cardId, cardId)).limit(1).get()
  if (file) return true
  const note = db
    .select({ id: cardNotes.id })
    .from(cardNotes)
    .where(and(eq(cardNotes.cardId, cardId), isNull(cardNotes.externalAuthor)))
    .limit(1)
    .get()
  return Boolean(note)
}

/** Une erreur GitHub dite à une route : un code que l'interface traduit. */
function httpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof BoardGitHubError) {
    const status = err.code === 'board_github_no_credential' ? 409 : err.transient ? 503 : 502
    return new HttpError(status, err.code, err.message)
  }
  return new HttpError(502, 'board_github_unreachable', err instanceof Error ? err.message : String(err))
}

/**
 * Le board relié à GitHub : tient les cartes à jour des issues, et renvoie vers GitHub
 * ce que Sillage change.
 *
 * Rien ne se marque « à envoyer » : chaque issue garde ce que GitHub disait à la
 * dernière lecture, et une carte qui en diffère a changé ici. Toutes les routes qui
 * touchent une carte, et `advanceCardOnLaunch`, sont donc couvertes sans le savoir.
 * Quand les deux côtés ont bougé, l'envoi passe avant la lecture : le geste le plus
 * récent, fait dans Sillage, gagne.
 */
export class BoardSync {
  private timer: NodeJS.Timeout | null = null
  private logger: FastifyBaseLogger | null = null
  private ticking = false
  /** Une file par projet : la lecture et une publication ne doivent pas se croiser. */
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly syncing = new Set<string>()
  private readonly kickTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly ctx: AppContext,
    private readonly credentials: Pick<GitCredentialStore, 'resolve'>,
    private readonly fetcher: FetchLike = fetch,
    /** Ouvre les sessions qui répondent aux commentaires ; absent, l'option ne fait rien. */
    private readonly responder?: Responder,
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
    for (const timer of this.kickTimers.values()) clearTimeout(timer)
    this.kickTimers.clear()
  }

  hasCredential(userId: string): boolean {
    try {
      return this.credentials.resolve(userId, 'github.com') !== undefined
    } catch {
      return false
    }
  }

  isSyncing(projectId: string): boolean {
    return this.syncing.has(projectId)
  }

  link(projectId: string): BoardLinkRow | undefined {
    return this.ctx.db.select().from(boardLinks).where(eq(boardLinks.projectId, projectId)).get()
  }

  /** L'issue suivie d'une carte, détachée ou non ; undefined pour une carte locale. */
  issueOf(cardId: string): CardIssueRow | undefined {
    return this.ctx.db.select().from(cardIssues).where(eq(cardIssues.cardId, cardId)).get()
  }

  /** Un changement fait dans Sillage : l'envoyer sans attendre le prochain passage. */
  kick(projectId: string): void {
    if (!this.timer || this.kickTimers.has(projectId)) return
    const timer = setTimeout(() => {
      this.kickTimers.delete(projectId)
      void this.run(projectId, false).catch(() => {})
    }, 500)
    timer.unref()
    this.kickTimers.set(projectId, timer)
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      this.failOrphanNotes()
      const links = this.ctx.db.select().from(boardLinks).all()
      for (const link of links) {
        const due = !link.lastSyncedAt || Date.now() - link.lastSyncedAt >= PULL_EVERY_MS
        await this.run(link.projectId, due).catch(() => {})
      }
    } finally {
      this.ticking = false
    }
  }

  /** « Synchroniser maintenant » : lève l'erreur, que la route rend telle quelle. */
  async syncNow(projectId: string): Promise<void> {
    await this.run(projectId, true, true)
  }

  /** Vérifie qu'un dépôt est joignable avec l'identifiant du compte, avant de relier. */
  async checkRepo(userId: string, repo: string): Promise<void> {
    try {
      const info = await this.client(userId, repo).repoInfo()
      if (!info.has_issues) throw new BoardGitHubError('board_github_issues_disabled', 'Issues are disabled on this repository.')
    } catch (err) {
      throw httpError(err)
    }
  }

  // --- Gestes des routes et des agents -----------------------------------------------

  /**
   * Crée l'issue, puis la carte qui la suit. Dans cet ordre : un refus de GitHub ne
   * laisse pas derrière lui une carte qui prétendrait être publiée.
   */
  async createIssueCard(
    projectId: string,
    userId: string,
    body: { title: string; description: string; column: CardColumn },
    agent?: { agent: AgentKind; conversationId: string },
  ): Promise<CardRow> {
    return this.serialized(projectId, async () => {
      const link = this.requireLink(projectId)
      const client = this.linkClient(link)
      try {
        const text = agent ? `${body.description}\n\n${publicationTail(link, agent.conversationId)}` : body.description
        let issue = await client.createIssue({ title: body.title, body: text })
        issue = await this.placeIssue(client, link, issue, body.column)
        const card = createCard(this.ctx.db, projectId, userId, body)
        this.track(link, card.id, issue)
        // Ses `#n` désignent désormais des issues : les liens se recalculent.
        syncCardReferences(this.ctx.db, card, card.description)
        return card
      } catch (err) {
        throw httpError(err)
      }
    })
  }

  /**
   * Publie une carte locale comme issue ; sur une carte détachée, la rattache à son
   * issue, GitHub reprenant alors la main sur le titre, la description et la colonne.
   */
  async publishCard(cardId: string): Promise<void> {
    const card = this.ctx.db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (!card) throw new HttpError(404, 'card_not_found', 'Card not found.')
    await this.serialized(card.projectId, async () => {
      const link = this.requireLink(card.projectId)
      const client = this.linkClient(link)
      const existing = this.issueOf(cardId)
      if (existing && !existing.detached) throw new HttpError(409, 'card_already_published', 'This card is already an issue.')
      try {
        if (existing) {
          const issue = await client.getIssue(existing.number)
          writeTransaction(this.ctx.db, (tx) => {
            tx.update(cardIssues).set({ ...issueColumns(issue, link.signature), detached: false }).where(eq(cardIssues.cardId, cardId)).run()
          })
          this.applyRemoteToCard(link, card, issue, true)
          return
        }
        let issue = await client.createIssue({ title: card.title, body: card.description })
        issue = await this.placeIssue(client, link, issue, card.column)
        this.track(link, cardId, issue)
        syncCardReferences(this.ctx.db, card, card.description)
      } catch (err) {
        throw httpError(err)
      }
    })
  }

  /** La carte redevient locale ; l'issue reste ouverte sur GitHub, sans suite ici. */
  detachCard(cardId: string): void {
    const issue = this.issueOf(cardId)
    if (!issue || issue.detached) throw new HttpError(409, 'card_not_published', 'This card is not linked to an issue.')
    this.ctx.db.update(cardIssues).set({ detached: true }).where(eq(cardIssues.cardId, cardId)).run()
    // Redevenue locale, ses `#n` désignent à nouveau des cartes.
    const card = this.ctx.db.select().from(cards).where(eq(cards.id, cardId)).get()
    if (card) syncCardReferences(this.ctx.db, card, card.description)
  }

  /** Une carte GitHub supprimée : la synchronisation ne doit pas la recréer. */
  hideIssue(projectId: string, number: number): void {
    const link = this.link(projectId)
    if (!link) return
    const hidden = new Set(parseHidden(link.hiddenIssues))
    hidden.add(number)
    this.ctx.db
      .update(boardLinks)
      .set({ hiddenIssues: JSON.stringify([...hidden].sort((a, b) => a - b)), updatedAt: Date.now() })
      .where(eq(boardLinks.projectId, projectId))
      .run()
  }

  // --- Passages ---------------------------------------------------------------------

  private async run(projectId: string, pull: boolean, raise = false): Promise<void> {
    await this.serialized(projectId, async () => {
      const link = this.link(projectId)
      if (!link) return
      this.syncing.add(projectId)
      const started = Date.now()
      try {
        const client = this.linkClient(link)
        const refused = await this.push(link, client)
        await this.publishNotes(link, client)
        let notice: string | null = null
        if (pull) {
          const events = await this.pull(link, client, started)
          this.prune(link)
          notice = await this.answer(events)
        }
        this.ctx.db
          .update(boardLinks)
          .set({ lastError: refused ?? notice, ...(pull ? { lastSyncedAt: started } : {}) })
          .where(eq(boardLinks.projectId, projectId))
          .run()
      } catch (err) {
        const code = err instanceof BoardGitHubError ? err.code : 'board_github_unreachable'
        if (!(err instanceof BoardGitHubError)) this.logger?.warn({ err, projectId }, 'synchronisation du board en échec')
        // L'échec compte comme un passage : on réessaiera au prochain, pas à chaque tic.
        this.ctx.db
          .update(boardLinks)
          .set({ lastError: code, ...(pull ? { lastSyncedAt: started } : {}) })
          .where(eq(boardLinks.projectId, projectId))
          .run()
        if (raise) throw httpError(err)
      } finally {
        this.syncing.delete(projectId)
      }
    })
  }

  /**
   * Ce que Sillage a changé sur les cartes suivies part vers leur issue. Rend le code du
   * dernier refus définitif, que le passage affichera.
   */
  private async push(link: BoardLinkRow, client: GitHubIssues): Promise<string | null> {
    let refused: string | null = null
    const rows = this.ctx.db
      .select({ card: cards, issue: cardIssues })
      .from(cardIssues)
      .innerJoin(cards, eq(cards.id, cardIssues.cardId))
      .where(and(eq(cardIssues.projectId, link.projectId), eq(cardIssues.repo, link.repo), eq(cardIssues.detached, false)))
      .all()

    for (const { card, issue } of rows) {
      const remote = remoteOf(issue)
      const patch: Parameters<GitHubIssues['updateIssue']>[1] = {}
      if (card.title !== issue.title) patch.title = card.title
      if (card.description !== issue.body) {
        patch.body = issue.marker ? `${card.description}\n\n${issue.marker}` : card.description
      }
      if (!columnMatches(card.column, remote, link)) Object.assign(patch, statePatch(desiredState(card.column, remote, link), remote))
      if (Object.keys(patch).length === 0) continue

      try {
        const updated = await client.updateIssue(issue.number, patch)
        this.ctx.db.update(cardIssues).set(issueColumns(updated, link.signature)).where(eq(cardIssues.cardId, card.id)).run()
      } catch (err) {
        if (!(err instanceof BoardGitHubError) || err.transient) throw err
        // Refus définitif (droits, issue verrouillée ou supprimée) : la carte reprend ce
        // que dit GitHub plutôt que de réessayer à chaque passage, et l'erreur s'affiche.
        this.ctx.db
          .update(cards)
          .set({ title: issue.title, description: issue.body, column: impliedColumn(remote, link), updatedAt: Date.now() })
          .where(eq(cards.id, card.id))
          .run()
        refused = err.code
      }
    }
    return refused
  }

  /** Les notes à publier partent en commentaire sur l'issue de leur carte. */
  private async publishNotes(link: BoardLinkRow, client: GitHubIssues): Promise<void> {
    const pending = this.ctx.db
      .select({
        id: cardNotes.id,
        body: cardNotes.body,
        conversationId: cardNotes.conversationId,
        agent: conversations.agent,
        number: cardIssues.number,
      })
      .from(cardNotes)
      .innerJoin(cardIssues, eq(cardIssues.cardId, cardNotes.cardId))
      .leftJoin(conversations, eq(conversations.id, cardNotes.conversationId))
      .where(
        and(
          eq(cardNotes.publication, 'pending'),
          eq(cardIssues.projectId, link.projectId),
          eq(cardIssues.repo, link.repo),
          eq(cardIssues.detached, false),
        ),
      )
      .all()

    for (const note of pending) {
      const body = note.conversationId
        ? `${note.body}\n\n${publicationTail(link, note.conversationId)}`
        : note.body
      try {
        const comment = await client.createComment(note.number, body)
        this.ctx.db
          .update(cardNotes)
          .set({ publication: 'published', publicationError: null, externalId: String(comment.id), externalUrl: comment.html_url })
          .where(eq(cardNotes.id, note.id))
          .run()
      } catch (err) {
        if (!(err instanceof BoardGitHubError) || err.transient) throw err
        this.ctx.db
          .update(cardNotes)
          .set({ publication: 'failed', publicationError: err.code })
          .where(eq(cardNotes.id, note.id))
          .run()
      }
    }
  }

  /**
   * Une note à publier dont la carte n'a plus d'issue suivie (détachée, board délié)
   * ne partira jamais : elle échoue plutôt que d'attendre en silence.
   */
  private failOrphanNotes(): void {
    this.ctx.db
      .update(cardNotes)
      .set({ publication: 'failed', publicationError: 'board_note_unlinked' })
      .where(
        and(
          eq(cardNotes.publication, 'pending'),
          sql`${cardNotes.cardId} NOT IN (
            SELECT ${cardIssues.cardId} FROM ${cardIssues}
            INNER JOIN ${boardLinks} ON ${boardLinks.projectId} = ${cardIssues.projectId}
              AND ${boardLinks.repo} = ${cardIssues.repo}
            WHERE ${cardIssues.detached} = 0)`,
        ),
      )
      .run()
  }

  /**
   * Lit GitHub. La première fois : les issues ouvertes, et les fermées depuis moins de
   * `closedDays`. Ensuite : tout ce qui a bougé depuis le curseur, issues et
   * commentaires, en deux requêtes pour tout le board.
   */
  private async pull(link: BoardLinkRow, client: GitHubIssues, started: number): Promise<MaintenanceEvent[]> {
    const tracked = new Map(
      this.ctx.db
        .select()
        .from(cardIssues)
        .where(and(eq(cardIssues.projectId, link.projectId), eq(cardIssues.repo, link.repo)))
        .all()
        .map((row) => [row.number, row]),
    )
    const hidden = new Set(parseHidden(link.hiddenIssues))
    const cutoff = started - link.closedDays * DAY_MS
    const filter = link.labelFilter.trim()
    const inWindow = (issue: GitHubIssue) =>
      issue.state === 'open' || (issue.closed_at !== null && Date.parse(issue.closed_at) >= cutoff)
    const matchesFilter = (issue: GitHubIssue) =>
      !filter || labelNames(issue).some((label) => label.toLowerCase() === filter.toLowerCase())

    let issues: GitHubIssue[]
    if (!link.cursor) {
      const open = await client.listIssues({ state: 'open', labels: filter || undefined })
      const closed =
        link.closedDays > 0
          ? await client.listIssues({ state: 'closed', labels: filter || undefined, since: new Date(cutoff).toISOString() })
          : []
      issues = [...open, ...closed]
    } else {
      issues = await client.listIssues({ state: 'all', since: link.cursor })
    }

    // Les cartes neuves dont l'issue a déjà des commentaires : ceux-là sont antérieurs
    // au curseur, la lecture des commentaires récents ne les ramènerait pas.
    const backfill: Array<{ cardId: string; number: number }> = []
    const events: MaintenanceEvent[] = []
    let created = false
    for (const issue of issues) {
      const existing = tracked.get(issue.number)
      if (existing) {
        if (!existing.detached && existing.remoteUpdatedAt !== issue.updated_at) this.refresh(link, existing, issue)
        continue
      }
      if (hidden.has(issue.number) || !inWindow(issue) || !matchesFilter(issue)) continue
      const card = createCard(this.ctx.db, link.projectId, link.userId, {
        title: cardTitle(issue.title),
        description: splitMarker(issue.body, link.signature).body,
        column: impliedColumn(issueRemote(issue), link),
      })
      const row = this.track(link, card.id, issue)
      tracked.set(issue.number, row)
      created = true
      if (this.isNew(link, issue.created_at, issue.body) && link.onIssue) events.push({ kind: 'issue', link, issue: row })
      if (issue.comments > 0) backfill.push({ cardId: card.id, number: issue.number })
    }

    // Des issues neuves : les `#n` des cartes suivies peuvent désormais viser une carte,
    // y compris entre deux issues arrivées dans ce même passage.
    if (created) this.relinkReferences(link)

    for (const entry of backfill) {
      for (const comment of await client.listIssueComments(entry.number)) this.applyComment(entry.cardId, comment, link.signature)
    }
    // Seuls les commentaires lus ici peuvent ouvrir une session : ceux de la première
    // lecture et des issues tout juste arrivées sont l'historique, que la session de
    // l'issue lira dans le fil de la carte.
    const batches = new Map<number, MaintenanceEvent & { kind: 'comment' }>()
    if (link.cursor) {
      const fresh = new Set(backfill.map((entry) => entry.number))
      for (const comment of await client.listRepoComments(link.cursor)) {
        const number = commentIssueNumber(comment)
        const row = number === null ? undefined : tracked.get(number)
        if (!row || row.detached || fresh.has(row.number)) continue
        if (this.applyComment(row.cardId, comment, link.signature) !== 'inserted') continue
        if (!link.onComment || !this.isNew(link, comment.created_at, comment.body)) continue
        const batch = batches.get(row.number) ?? { kind: 'comment' as const, link, issue: row, comments: [] }
        batch.comments.push(comment)
        batches.set(row.number, batch)
      }
    }
    events.push(...batches.values())

    this.ctx.db
      .update(boardLinks)
      .set({ cursor: new Date(started - CURSOR_MARGIN_MS).toISOString() })
      .where(eq(boardLinks.projectId, link.projectId))
      .run()
    return events
  }

  /**
   * Une issue ou un commentaire ouvre-t-il une session ? Seulement s'il est nouveau et ne
   * porte pas de marque de session : l'auteur ne compte pas, une issue ouverte par
   * l'utilisateur sur github.com est une issue comme les autres. Ce que Sillage publie
   * lui-même est déjà connu et n'arrive pas jusque-là ; ce qu'un agent publie avec `gh`
   * porte la marque.
   */
  private isNew(link: BoardLinkRow, createdAt: string, body: string | null): boolean {
    if (!this.responder || !link.cursor) return false
    // Ce qu'on découvre parce qu'il vient d'être modifié, ou d'entrer dans le filtre,
    // n'est pas nouveau pour autant.
    if (Date.parse(createdAt) < Date.parse(link.cursor)) return false
    return findSessionMarkers(body ?? '').length === 0
  }

  /** Les sessions de maintenance, une par issue. Rend le code d'un refus à afficher. */
  private async answer(events: MaintenanceEvent[]): Promise<string | null> {
    let notice: string | null = null
    for (const event of events) {
      try {
        if ((await this.responder!.respond(event)) === 'limited') notice = 'board_maintenance_rate_limited'
      } catch (err) {
        this.logger?.warn({ err, issue: event.issue.number }, 'session de maintenance impossible à lancer')
        notice = 'board_maintenance_failed'
      }
    }
    return notice
  }

  private relinkReferences(link: BoardLinkRow): void {
    const rows = this.ctx.db
      .select({ card: cards })
      .from(cardIssues)
      .innerJoin(cards, eq(cards.id, cardIssues.cardId))
      .where(and(eq(cardIssues.projectId, link.projectId), eq(cardIssues.detached, false)))
      .all()
    for (const { card } of rows) {
      if (card.description.includes('#')) syncCardReferences(this.ctx.db, card, card.description)
    }
  }

  /** Une issue suivie a bougé sur GitHub : la carte prend ce qui a changé, et seulement ça. */
  private refresh(link: BoardLinkRow, existing: CardIssueRow, issue: GitHubIssue): void {
    const card = this.ctx.db.select().from(cards).where(eq(cards.id, existing.cardId)).get()
    if (!card) return
    const before = remoteOf(existing)
    const after = issueRemote(issue)
    const { body } = splitMarker(issue.body, link.signature)
    const patch: Partial<typeof cards.$inferInsert> = {}
    if (cardTitle(issue.title) !== existing.title) patch.title = cardTitle(issue.title)
    if (body !== existing.body) patch.description = body
    if (columnStateChanged(before, after, link) && !columnMatches(card.column, after, link)) {
      patch.column = impliedColumn(after, link)
      patch.position = this.endOf(card.projectId, patch.column)
    }
    this.ctx.db.update(cardIssues).set(issueColumns(issue, link.signature)).where(eq(cardIssues.cardId, card.id)).run()
    if (Object.keys(patch).length === 0) return
    this.ctx.db.update(cards).set({ ...patch, updatedAt: Date.now() }).where(eq(cards.id, card.id)).run()
    if (patch.description !== undefined) syncCardReferences(this.ctx.db, card, patch.description)
  }

  /** La carte reprend tout de l'issue : au rattachement d'une carte détachée. */
  private applyRemoteToCard(link: BoardLinkRow, card: CardRow, issue: GitHubIssue, moveColumn: boolean): void {
    const { body } = splitMarker(issue.body, link.signature)
    const column = impliedColumn(issueRemote(issue), link)
    const patch: Partial<typeof cards.$inferInsert> = { title: cardTitle(issue.title), description: body, updatedAt: Date.now() }
    if (moveColumn && !columnMatches(card.column, issueRemote(issue), link)) {
      patch.column = column
      patch.position = this.endOf(card.projectId, column)
    }
    this.ctx.db.update(cards).set(patch).where(eq(cards.id, card.id)).run()
    syncCardReferences(this.ctx.db, card, body)
  }

  /**
   * Un commentaire GitHub devient une note, ou met à jour la sienne. Les notes publiées
   * depuis Sillage se reconnaissent à leur identifiant et ne sont pas réécrites : leur
   * version GitHub porte la signature, la note garde le texte écrit ici.
   */
  private applyComment(cardId: string, comment: GitHubComment, signature: string): 'inserted' | 'known' {
    const externalId = String(comment.id)
    const body = splitMarker(comment.body, signature).body
    const existing = this.ctx.db
      .select({ id: cardNotes.id, body: cardNotes.body, externalAuthor: cardNotes.externalAuthor })
      .from(cardNotes)
      .where(and(eq(cardNotes.cardId, cardId), eq(cardNotes.externalId, externalId)))
      .get()
    if (existing) {
      if (existing.externalAuthor !== null && existing.body !== body) {
        this.ctx.db.update(cardNotes).set({ body }).where(eq(cardNotes.id, existing.id)).run()
      }
      return 'known'
    }
    this.ctx.db
      .insert(cardNotes)
      .values({
        id: randomUUID(),
        cardId,
        conversationId: null,
        userId: null,
        body: body || ' ',
        // Borné à maintenant : une horloge GitHub en avance rangerait le commentaire
        // après les notes écrites ici juste après lui.
        createdAt: Math.min(Date.parse(comment.created_at), Date.now()),
        externalId,
        externalAuthor: comment.user?.login ?? 'ghost',
        externalUrl: comment.html_url,
      })
      .run()
    return 'inserted'
  }

  /**
   * Les issues fermées depuis plus de `closedDays` quittent le board, sauf si leur carte
   * porte du travail local : celle-là reste, comme une carte locale terminée.
   */
  private prune(link: BoardLinkRow): void {
    const cutoff = Date.now() - link.closedDays * DAY_MS
    const stale = this.ctx.db
      .select({ cardId: cardIssues.cardId })
      .from(cardIssues)
      .where(
        and(
          eq(cardIssues.projectId, link.projectId),
          eq(cardIssues.detached, false),
          eq(cardIssues.state, 'closed'),
          isNotNull(cardIssues.closedAt),
          lt(cardIssues.closedAt, cutoff),
        ),
      )
      .all()
      .map((row) => row.cardId)
      .filter((cardId) => !hasLocalWork(this.ctx.db, cardId))
    if (stale.length > 0) this.ctx.db.delete(cards).where(inArray(cards.id, stale)).run()
  }

  // --- Outils -----------------------------------------------------------------------

  private track(link: BoardLinkRow, cardId: string, issue: GitHubIssue): CardIssueRow {
    const row = {
      cardId,
      projectId: link.projectId,
      provider: 'github' as const,
      repo: link.repo,
      number: issue.number,
      detached: false,
      responderId: null,
      ...issueColumns(issue, link.signature),
    }
    this.ctx.db.insert(cardIssues).values(row).run()
    return row
  }

  /** Donne à une issue neuve l'état de la colonne où sa carte est créée. */
  private async placeIssue(client: GitHubIssues, link: BoardLinkRow, issue: GitHubIssue, column: CardColumn): Promise<GitHubIssue> {
    const remote = issueRemote(issue)
    if (columnMatches(column, remote, link)) return issue
    return client.updateIssue(issue.number, statePatch(desiredState(column, remote, link), remote))
  }

  private endOf(projectId: string, column: CardColumn): number {
    const [last] = this.ctx.db
      .select({ position: max(cards.position) })
      .from(cards)
      .where(and(eq(cards.projectId, projectId), eq(cards.column, column)))
      .all()
    return (last?.position ?? 0) + 1
  }

  private requireLink(projectId: string): BoardLinkRow {
    const link = this.link(projectId)
    if (!link) throw new HttpError(409, 'board_not_linked', 'This board is not linked to GitHub.')
    return link
  }

  private linkClient(link: BoardLinkRow): GitHubIssues {
    return this.client(link.userId, link.repo)
  }

  private client(userId: string, repo: string): GitHubIssues {
    const credential = this.credentials.resolve(userId, 'github.com')
    if (!credential) throw new BoardGitHubError('board_github_no_credential', 'No GitHub credential for this account.')
    return new GitHubIssues(credential.token, repo, this.fetcher)
  }

  private serialized<T>(projectId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(body)
    const settled = next.catch(() => {})
    this.queues.set(projectId, settled)
    void settled.then(() => {
      if (this.queues.get(projectId) === settled) this.queues.delete(projectId)
    })
    return next
  }
}

/** Le corps de PATCH qui fait passer l'issue de `remote` à `wanted`. */
function statePatch(wanted: RemoteState, remote: RemoteState): Parameters<GitHubIssues['updateIssue']>[1] {
  const patch: Parameters<GitHubIssues['updateIssue']>[1] = {}
  if (wanted.state !== remote.state || wanted.stateReason !== remote.stateReason) {
    patch.state = wanted.state
    if (wanted.state === 'closed' && wanted.stateReason) patch.state_reason = wanted.stateReason
  }
  const sameLabels =
    wanted.labels.length === remote.labels.length &&
    wanted.labels.every((label) => remote.labels.some((entry) => entry.toLowerCase() === label.toLowerCase()))
  if (!sameLabels) patch.labels = wanted.labels
  return patch
}
