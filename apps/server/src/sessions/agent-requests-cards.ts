import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { cardNotes, cards, conversations } from '@sillage/db'
import { createCardRelationBodySchema, updateCardBodySchema } from '@sillage/protocol'
import { linkCards, unlinkCards } from '../board/card-relations.js'
import { resolveAgentTags, setCardTags, TagRefusal, type TagAuthor } from '../board/card-tags.js'
import type { BoardSync } from '../board/board-sync.js'
import type { AppContext } from '../http/context.js'
import { createCard, updateCard } from '../http/routes/cards.js'
import { Refusal, type Requester } from './agent-requests-shared.js'
import type { SessionManager } from './session-manager.js'

/** Board requests: `create_card`, `update_card`, `attach_card`/`detach_card` and `link_cards`/`unlink_cards`. */

/** The project's card named by an agent-supplied number (`12` or `"#12"`), or null when none was given. */
export function findCard(db: AppContext['db'], projectId: string, value: unknown): { id: string; number: number; title: string } | null {
  if (value === undefined || value === null || value === '') return null
  const number = typeof value === 'number' ? value : Number(String(value).replace(/^#/, ''))
  if (!Number.isInteger(number)) throw new Refusal('The `card` parameter is a card number, e.g. 12.')
  const card = db
    .select({ id: cards.id, number: cards.number, title: cards.title })
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
    .get()
  if (!card) throw new Refusal(`No card #${number} in this project. Use list_cards to see cards.`)
  return card
}

export class CardRequests {
  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: Pick<SessionManager, 'statusBus'>,
    /** GitHub board connection; absent keeps `create_card` local. */
    private readonly board?: BoardSync,
  ) {}

  link(kind: 'link_cards' | 'unlink_cards', requester: Requester, payload: Record<string, unknown>): string {
    if (!Number.isInteger(payload.number)) throw new Refusal('The card number is required.')
    const { target, kind: relation } = createCardRelationBodySchema.parse(payload)
    const change = kind === 'link_cards' ? linkCards : unlinkCards
    change(this.ctx.db, requester.projectId, payload.number as number, target, relation)
    return kind === 'link_cards' ? 'Relation added.' : 'Relation removed.'
  }

  update(requester: Requester, payload: Record<string, unknown>): string {
    if (!Number.isInteger(payload.number)) throw new Refusal('The card number is required.')
    const card = this.ctx.db.select().from(cards)
      .where(and(eq(cards.projectId, requester.projectId), eq(cards.number, payload.number as number))).get()
    if (!card) throw new Refusal('No card with this number in the project.')
    const body = updateCardBodySchema.pick({ title: true, description: true }).parse({
      title: typeof payload.title === 'string' ? payload.title.trim() : payload.title,
      description: payload.description,
    })
    if (body.title === undefined && body.description === undefined && payload.tags === undefined) {
      throw new Refusal('Provide at least a title, description or tags to change.')
    }
    // Resolve tags before writing anything: a refused name must leave the card untouched.
    const tags = payload.tags === undefined ? null : this.resolveTags(requester, payload.tags)
    if (tags) setCardTags(this.ctx.db, card.id, requester.projectId, tags.ids)
    updateCard(this.ctx.db, card, body)
    this.board?.kick(requester.projectId)
    return `Card #${card.number} updated.${tags ? describeTags(tags) : ''}`
  }

  private resolveTags(requester: Requester, names: unknown): { ids: string[]; created: string[]; names: string[] } {
    const author: TagAuthor = { userId: requester.userId, conversationId: requester.id || null }
    try {
      const resolved = resolveAgentTags(this.ctx.db, requester.projectId, names, author)
      return { ...resolved, names: (names as string[]).map((name) => name.trim()).filter(Boolean) }
    } catch (err) {
      if (err instanceof TagRefusal) throw new Refusal(err.message)
      throw err
    }
  }

  // --- attach_card / detach_card -------------------------------------------------

  /**
   * Attaches the requesting session to a card, the link the board counts as work on it. Unlike
   * attaching from the interface, which records past work, an agent attaches as it starts: a
   * card still in todo therefore moves to in progress, as when a session is launched from it.
   */
  attach(kind: 'attach_card' | 'detach_card', requester: Requester, payload: Record<string, unknown>): string {
    if (!requester.id || requester.personal) throw new Refusal('Only a project session can be attached to one of its cards.')
    const current = this.ctx.db.select({ cardId: conversations.cardId }).from(conversations).where(eq(conversations.id, requester.id)).get()
    if (kind === 'detach_card') {
      if (!current?.cardId) return 'This session is not attached to a card.'
      const card = this.ctx.db.select({ number: cards.number }).from(cards).where(eq(cards.id, current.cardId)).get()
      this.ctx.db.update(conversations).set({ cardId: null }).where(eq(conversations.id, requester.id)).run()
      this.sessions.statusBus.emit('lists')
      return card ? `Session detached from card #${card.number}; the card keeps its column and notes.` : 'Session detached.'
    }

    const card = findCard(this.ctx.db, requester.projectId, payload.number)
    if (!card) throw new Refusal('The `number` parameter is required: the card number, e.g. 12.')
    if (current?.cardId === card.id) return `This session is already attached to card #${card.number} “${card.title}”.`
    const previous = current?.cardId
      ? this.ctx.db.select({ number: cards.number }).from(cards).where(eq(cards.id, current.cardId)).get()
      : undefined
    this.ctx.db.update(conversations).set({ cardId: card.id }).where(eq(conversations.id, requester.id)).run()
    const advanced = this.ctx.db
      .update(cards)
      .set({ column: 'in_progress', updatedAt: Date.now() })
      .where(and(eq(cards.id, card.id), eq(cards.column, 'todo')))
      .run().changes > 0
    this.board?.kick(requester.projectId)
    this.sessions.statusBus.emit('lists')
    return [
      `Session attached to card #${card.number} “${card.title}”${previous ? ` (replacing #${previous.number})` : ''}${advanced ? ', moved to in progress' : ''}.`,
      'The user now sees the card in the session list and header. Call read_card for its description and previous notes if you have not; leave a note with add_card_note before finishing.',
    ].join(' ')
  }

  // --- create_card ---------------------------------------------------------------

  /** Always create todo cards: agent ideas are proposals rather than started work. Advance when sessions take them, like other cards. */
  async create(requester: Requester, payload: Record<string, unknown>): Promise<string> {
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    const description = typeof payload.description === 'string' ? payload.description.trim() : ''
    if (!title) throw new Refusal('The `title` parameter is required.')
    if (title.length > 200) throw new Refusal('Title too long (maximum 200 characters).')
    if (description.length > 20000) throw new Refusal('Description too long (maximum 20,000 characters).')
    const tags = payload.tags === undefined ? null : this.resolveTags(requester, payload.tags)

    // Board settings decide unless agents explicitly request otherwise based on
    // user instructions, as tool descriptions require.
    const link = this.board?.link(requester.projectId)
    if (payload.github === true && !link) {
      throw new Refusal('This board is not linked to GitHub: cards can only be local. Retry without `github`.')
    }
    const github = Boolean(link) && (typeof payload.github === 'boolean' ? payload.github : link?.newCards === 'github')
    const fields = { title, description, column: 'todo' as const }
    const card =
      github && this.board
        ? await this.board.createIssueCard(
            requester.projectId,
            requester.userId,
            fields,
            requester.id ? { agent: requester.agent, conversationId: requester.id } : undefined,
          )
        : createCard(this.ctx.db, requester.projectId, requester.userId, fields)
    if (tags && tags.ids.length > 0) setCardTags(this.ctx.db, card.id, requester.projectId, tags.ids)
    // Provenance lives in card threads with session links, preserving agent-written
    // descriptions while showing origins to subsequent users.
    // Account-created cards already identify their authors.
    if (requester.id) {
      this.ctx.db
        .insert(cardNotes)
        .values({
          id: randomUUID(),
          cardId: card.id,
          conversationId: requester.id,
          userId: null,
          body: 'Carte ouverte depuis cette session.',
          createdAt: Date.now(),
        })
        .run()
    }

    const issue = github ? this.board?.issueOf(card.id) : undefined
    const where = issue
      ? ` and published as GitHub issue #${issue.number} (${issue.url}), visible to everyone if the repository is public`
      : link
        ? ', local (not published to GitHub)'
        : ''
    return `Card #${card.number} “${card.title}” created in todo${where}.${tags ? describeTags(tags) : ''} To handle it immediately in a new session, start_session (when available) accepts card=${card.number}.`
  }
}

/** Tag outcome for the agent, naming new tags so it can tell the user it grew the catalog. */
function describeTags(tags: { created: string[]; names: string[] }): string {
  if (tags.names.length === 0) return ' Tags cleared.'
  const created = tags.created.length > 0 ? ` New tag(s) created: ${tags.created.join(', ')}.` : ''
  return ` Tags: ${tags.names.join(', ')}.${created}`
}
