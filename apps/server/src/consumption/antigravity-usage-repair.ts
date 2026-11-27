import { sql } from 'drizzle-orm'
import type { Db } from '@sillage/db'
import { antigravityTurnTokens, type AntigravityTurnTokens } from '../agents/antigravity/usage.js'

const KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const

/**
 * Antigravity turns journaled before `antigravityTurnTokens` copied Google's raw input, cache
 * read included, so the cache was counted twice. Their native `usage` was journaled beside them:
 * the turn's counters are read again from it, and everything derived from them is corrected at
 * once (journal, conversation totals, `turn_usage`), while benchmark runs on those threads are
 * folded again at their next read. Turns that already agree are left alone, so a second pass is
 * harmless.
 */
export function repairAntigravityUsage(db: Db): number {
  const turns = db.all<{ conversationId: string; seq: number; payload: string; usage: string }>(sql`
    select e.conversation_id as conversationId, e.seq, e.payload, json_extract(e.raw, '$.usage') as usage
    from events e join conversations c on c.id = e.conversation_id
    where c.agent = 'antigravity' and e.type = 'turn.completed' and json_type(e.raw, '$.usage') = 'object'`)
  const repaired = new Set<string>()
  db.transaction((tx) => {
    for (const turn of turns) {
      let journaled: Record<string, unknown> & Partial<AntigravityTurnTokens>
      let tokens: AntigravityTurnTokens
      try {
        journaled = JSON.parse(turn.payload)
        tokens = antigravityTurnTokens(JSON.parse(turn.usage))
      } catch { continue }
      const was = Object.fromEntries(KEYS.map((key) => [key, Number(journaled[key]) || 0])) as unknown as AntigravityTurnTokens
      if (KEYS.every((key) => was[key] === tokens[key])) continue
      tx.run(sql`update events set payload = ${JSON.stringify({ ...journaled, ...tokens })} where conversation_id = ${turn.conversationId} and seq = ${turn.seq}`)
      tx.run(sql`
        update conversations set
          input_tokens = max(0, input_tokens + ${tokens.inputTokens - was.inputTokens}),
          output_tokens = max(0, output_tokens + ${tokens.outputTokens - was.outputTokens})
        where id = ${turn.conversationId}`)
      tx.run(sql`
        update turn_usage set input_tokens = ${tokens.inputTokens}, output_tokens = ${tokens.outputTokens},
          cache_read_tokens = ${tokens.cacheReadTokens}, cache_write_tokens = ${tokens.cacheCreationTokens}
        where conversation_id = ${turn.conversationId} and seq = ${turn.seq}`)
      repaired.add(turn.conversationId)
    }
    // Version 0 sends the run back through the fold of `benchmarksToDto`, now over the corrected journal.
    for (const id of repaired) {
      tx.run(sql`update benchmark_runs set metrics = json_set(metrics, '$.version', 0) where conversation_id = ${id} and metrics is not null`)
    }
  })
  return repaired.size
}
