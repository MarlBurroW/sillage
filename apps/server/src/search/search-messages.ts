import { sql } from 'drizzle-orm'
import type { Db } from '@sillage/db'
import {
  SEARCH_MARK_CLOSE,
  SEARCH_MARK_OPEN,
  type AgentKind,
  type SearchMessageDto,
} from '@sillage/protocol'

/** Converts free text to FTS5 queries. Quote every term to neutralize engine syntax: `-` and `\"` inside sentences must not fail queries. Allow a prefix on the last term because typing is ongoing. Terms without letters or digits produce no tokens and correctly return nothing rather than errors. */
function toMatchQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term, index, terms) => {
      const quoted = `"${term.replaceAll('"', '""')}"`
      return index === terms.length - 1 ? `${quoted}*` : quoted
    })
    .join(' ')
}

interface Row {
  conversationId: string
  projectId: string | null
  conversationTitle: string
  agent: AgentKind
  seq: number
  role: string
  ts: number
  excerpt: string
}

/** Matching messages in conversations this account can view. Apply visibility within the query: private excerpts reaching HTTP would leak if downstream filtering were forgotten. Joining `conversations` also hides orphaned rows from FTS5's lack of cascades. Exclude archived conversations like navigation elsewhere in the interface. */
export function searchMessages(
  db: Db,
  userId: string,
  query: string,
  limit: number,
): SearchMessageDto[] {
  const match = toMatchQuery(query)
  if (!match) return []

  const rows = db.all<Row>(sql`
    SELECT m.conversation_id AS conversationId,
           c.project_id AS projectId,
           c.title AS conversationTitle,
           c.agent AS agent,
           m.seq AS seq,
           m.role AS role,
           m.ts AS ts,
           snippet(search_messages, 0, ${SEARCH_MARK_OPEN}, ${SEARCH_MARK_CLOSE}, '...', 12) AS excerpt
    FROM search_messages AS m
    JOIN conversations AS c ON c.id = m.conversation_id
    LEFT JOIN projects AS p ON p.id = c.project_id
    WHERE search_messages MATCH ${match}
      AND c.archived_at IS NULL
      AND ((c.project_id IS NULL AND c.user_id = ${userId}) OR p.owner_id = ${userId} OR p.visibility = 'shared')
    ORDER BY bm25(search_messages)
    LIMIT ${limit}
  `)

  return rows.map((row) => ({
    conversationId: row.conversationId,
    projectId: row.projectId,
    conversationTitle: row.conversationTitle,
    agent: row.agent,
    seq: row.seq,
    // Roles come from already-validated indexed events;
    // anything other than a user message belongs to the agent.
    role: row.role === 'user' ? 'user' : 'assistant',
    ts: row.ts,
    excerpt: row.excerpt,
  }))
}
