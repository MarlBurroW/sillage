import { randomUUID } from 'node:crypto'
import { eq, min } from 'drizzle-orm'
import { conversations, type ConversationRow, type Db } from '@sillage/db'
import type { AgentConfig, AgentKind } from '@sillage/protocol'
import type { OutgoingAttachment } from '../agents/types.js'
import type { SessionManager } from '../sessions/session-manager.js'

const PROVISIONAL_TITLE_MAX = 60

/**
 * Titre affiché entre la création et le résumé du CLI, c'est-à-dire le temps du
 * premier tour. Un extrait du message dit déjà de quoi il s'agit, contrairement à un
 * « Nouvelle conversation » identique pour toutes.
 */
export function provisionalTitle(firstMessage: string | undefined): string {
  const text = firstMessage?.trim().replace(/\s+/g, ' ')
  if (!text) return 'Nouvelle conversation'
  return text.length <= PROVISIONAL_TITLE_MAX
    ? text
    : `${text.slice(0, PROVISIONAL_TITLE_MAX).trimEnd()}...`
}

export interface CreateConversationInput {
  projectId: string
  userId: string
  agent: AgentKind
  /** Déjà résolue : les `CLI_DEFAULT` sont remplacés avant l'écriture. */
  config: AgentConfig
  worktreeId: string | null
  title?: string
  /** Jeton d'API à l'origine de la conversation ; null quand elle vient de l'interface. */
  origin: { tokenId: string; label: string } | null
  firstMessage?: {
    clientMessageId: string
    text: string
    attachments: OutgoingAttachment[]
    mentions: string[]
    skills: string[]
  }
}

/**
 * Crée une conversation et lui envoie son premier message.
 *
 * Partagé entre l'interface et l'API : le vocabulaire diffère mais le geste est le
 * même, et deux copies auraient divergé au premier champ ajouté.
 */
export async function createConversation(
  db: Db,
  sessions: SessionManager,
  input: CreateConversationInput,
): Promise<ConversationRow> {
  // Position en tête du projet : c'est l'ordre qu'avait le tri par date, et une
  // nouvelle conversation en bas de liste passerait inaperçue.
  const [lowest] = db
    .select({ min: min(conversations.position) })
    .from(conversations)
    .where(eq(conversations.projectId, input.projectId))
    .all()

  const now = Date.now()
  const row: ConversationRow = {
    id: randomUUID(),
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    userId: input.userId,
    title: input.title ?? provisionalTitle(input.firstMessage?.text),
    titleSetByUser: input.title !== undefined,
    agent: input.agent,
    agentSessionId: null,
    forkedFromId: null,
    createdByTokenId: input.origin?.tokenId ?? null,
    originLabel: input.origin?.label ?? null,
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

  if (input.firstMessage) {
    // Si l'envoi échoue, la conversation ne doit pas rester comme un fil vide :
    // on la retire et on remonte l'erreur telle quelle.
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
