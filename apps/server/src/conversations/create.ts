import { randomUUID } from 'node:crypto'
import { eq, min } from 'drizzle-orm'
import { conversationHandoffs, conversations, type ConversationRow, type Db } from '@sillage/db'
import type { AgentConfig, AgentKind } from '@sillage/protocol'
import type { OutgoingAttachment } from '../agents/types.js'
import type { SessionManager } from '../sessions/session-manager.js'

const PROVISIONAL_TITLE_MAX = 60

/** Title between creation and CLI summarization, during the first turn. Message excerpts already identify the subject instead of identical 'New conversation' labels. */
export function provisionalTitle(firstMessage: string | undefined): string {
  const text = firstMessage?.trim().replace(/\s+/g, ' ')
  if (!text) return 'Nouvelle conversation'
  return text.length <= PROVISIONAL_TITLE_MAX
    ? text
    : `${text.slice(0, PROVISIONAL_TITLE_MAX).trimEnd()}...`
}

export interface CreateConversationInput {
  /** Explicit ID when the first message must reference it: webhook-created sessions receive the forge marker carrying their own identifier. */
  id?: string
  projectId: string
  userId: string
  agent: AgentKind
  /** Already resolved: replace `CLI_DEFAULT` before writing. */
  config: AgentConfig
  worktreeId: string | null
  /** Target card when launched from the board. */
  cardId: string | null
  title?: string
  /** Text for provisional titles when the first message is unsuitable: delegated missions start with a tagged envelope. */
  titleSource?: string
  /** Originating API token; null for interface-created conversations. */
  origin: { tokenId: string; label: string } | null
  /** Scheduled task whose run this conversation represents; absent otherwise. */
  scheduleId?: string
  /** Context handed off from another conversation when continuing in another CLI. Write alongside the row so the first CLI start can find it. */
  handoff?: {
    fromConversationId: string
    throughSeq: number
    budgetTokens: number
    text: string
  }
  firstMessage?: {
    clientMessageId: string
    text: string
    attachments: OutgoingAttachment[]
    mentions: string[]
    skills: string[]
  }
}

/** Creates conversations and sends their first message. Shared by interface and API: terminology differs but the action is identical, and duplicated code would diverge at the first added field. */
export async function createConversation(
  db: Db,
  sessions: SessionManager,
  input: CreateConversationInput,
): Promise<ConversationRow> {
  // Place first within the project, matching the previous date order:
  // new conversations at the bottom would go unnoticed.
  const [lowest] = db
    .select({ min: min(conversations.position) })
    .from(conversations)
    .where(eq(conversations.projectId, input.projectId))
    .all()

  const now = Date.now()
  const row: ConversationRow = {
    id: input.id ?? randomUUID(),
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    cardId: input.cardId,
    userId: input.userId,
    title: input.title ?? provisionalTitle(input.titleSource ?? input.firstMessage?.text),
    titleSetByUser: input.title !== undefined,
    agent: input.agent,
    agentSessionId: null,
    forkedFromId: null,
    handoffFromId: input.handoff?.fromConversationId ?? null,
    createdByTokenId: input.origin?.tokenId ?? null,
    originLabel: input.origin?.label ?? null,
    scheduleId: input.scheduleId ?? null,
    config: JSON.stringify(input.config),
    status: 'idle',
    backgroundCount: 0,
    loopCount: 0,
    lastSeq: 0,
    lastNotableSeq: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turnCount: 0,
    journalBytes: 0,
    contextUsedTokens: null,
    contextMaxTokens: null,
    model: null,
    pinned: false,
    position: (lowest?.min ?? 0) - 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(conversations).values(row).run()
  if (input.handoff) {
    db.insert(conversationHandoffs)
      .values({ conversationId: row.id, createdAt: now, ...input.handoff })
      .run()
  }

  if (input.firstMessage) {
    // Failed sends must not leave empty conversations:
    // remove it and propagate the original error.
    try {
      await sessions.sendMessage(
        row.id,
        input.firstMessage.clientMessageId,
        input.firstMessage.text,
        input.firstMessage.attachments,
        input.firstMessage.mentions,
        input.firstMessage.skills,
      )
    } catch (err) {
      db.delete(conversations).where(eq(conversations.id, row.id)).run()
      throw err
    }
  }

  return row
}
