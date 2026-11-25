import { and, eq, sql } from 'drizzle-orm'
import { events, type Db } from '@sillage/db'
import type { ConversationStatsDto } from '@sillage/protocol'
import type { PriceCatalog } from '../pricing/catalog.js'
import { conversationUsage } from '../pricing/conversation-usage.js'

/** Enough to read a session's habits at a glance; a longer tail would only be noise in a popover. */
const TOP_TOOLS = 5

/**
 * Cost and tool activity of one conversation. Tool calls are counted by distinct `toolCallId`
 * because resynchronization can journal the same call twice; the native-tool index covers the
 * conversation, type and identifier, so even long journals are read without a scan.
 */
export function conversationStats(db: Db, prices: PriceCatalog, conversationId: string): ConversationStatsDto {
  const callId = sql`${events.payload} ->> '$.toolCallId'`
  const byName = db
    .select({ name: sql<string>`${events.payload} ->> '$.name'`, count: sql<number>`count(distinct ${callId})` })
    .from(events)
    .where(and(eq(events.conversationId, conversationId), eq(events.type, 'tool.started')))
    .groupBy(sql`1`)
    .all()
    .filter(row => row.name)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const errors = db
    .select({ count: sql<number>`count(distinct ${callId})` })
    .from(events)
    .where(and(eq(events.conversationId, conversationId), eq(events.type, 'tool.completed'), sql`${events.payload} ->> '$.isError' = 1`))
    .get()
  const usage = conversationUsage(db, prices, conversationId)
  const tokens = usage?.tokens
  return {
    costUsd: usage?.costUsd ?? null,
    tokens: {
      input: tokens?.inputTokens ?? 0,
      output: tokens?.outputTokens ?? 0,
      cacheRead: tokens?.cacheReadTokens ?? 0,
      cacheWrite: (tokens?.cacheWriteTokens ?? 0) + (tokens?.cacheWrite1hTokens ?? 0),
    },
    toolCalls: byName.reduce((sum, row) => sum + row.count, 0),
    toolErrors: errors?.count ?? 0,
    tools: byName.slice(0, TOP_TOOLS),
  }
}
