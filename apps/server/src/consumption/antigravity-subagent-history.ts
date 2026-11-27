import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { conversations, turnUsage, type Db } from '@sillage/db'
import { addTokens, hasTokens, noTokens, parseTranscriptLine, transcriptPath, type TranscriptStep } from '../agents/antigravity/subagent-usage.js'
import type { AntigravityTurnTokens } from '../agents/antigravity/usage.js'

/**
 * Antigravity sub-agents consumed tokens that no turn reported before the runner read their
 * transcripts (see `AntigravitySubAgentUsage`). The transcripts are still in each conversation's
 * session view: what they hold before `cutoff` is read back once, and later steps are the live
 * runners' to report. Each `INVOKE_SUBAGENT` step is matched to the `invoke_subagent` tool the
 * journal opened at the same moment, whose sequence keys the row: the tool call's own id does not
 * carry the step's index.
 */

async function steps(brain: string, id: string): Promise<TranscriptStep[]> {
  let text: string
  try { text = await readFile(transcriptPath(brain, id), 'utf8') } catch { return [] }
  return text.split('\n').flatMap((line) => {
    const step = line.trim() ? parseTranscriptLine(line) : null
    return step ? [step] : []
  })
}

/** One row per `invoke_subagent` with usage, ready for `turn_usage`. Reads, never writes. */
export async function collectAntigravitySubAgentUsage(db: Db, homes: { accounts: string | null; user: string }, cutoff: number) {
  const rows: (typeof turnUsage.$inferInsert)[] = []
  const owners = db.all<{ id: string; userId: string; projectId: string | null; model: string | null; sessionId: string; account: string | null }>(sql`
    select id, user_id as userId, project_id as projectId, model, agent_session_id as sessionId, config ->> '$.account' as account
    from conversations where agent = 'antigravity' and agent_session_id is not null order by created_at`)
  for (const owner of owners) {
    const invoked = db.all<{ seq: number; ts: number }>(sql`
      select seq, ts from events
      where conversation_id = ${owner.id} and type = 'tool.started' and (payload ->> '$.name') = 'invoke_subagent' order by seq`)
    if (!invoked.length || !/^[\w-]+$/.test(owner.id) || !/^[\w-]+$/.test(owner.sessionId)) continue
    const candidates = [...(owner.account && homes.accounts && /^[\w-]+$/.test(owner.account) ? [join(homes.accounts, owner.account)] : []), homes.user]
    let brain: string | null = null
    let main: TranscriptStep[] = []
    for (const home of candidates) {
      const dir = join(home, 'sillage-sessions', owner.id, 'antigravity-acp', 'brain')
      main = await steps(dir, owner.sessionId)
      if (main.length) { brain = dir; break }
    }
    if (!brain) continue
    const bySeq = new Map<number, AntigravityTurnTokens>()
    const visited = new Set<string>([owner.sessionId])
    for (const step of main) {
      if (!step.children.length) continue
      const tool = invoked.reduce((best, next) => Math.abs(next.ts - step.createdAt) < Math.abs(best.ts - step.createdAt) ? next : best)
      const tokens = bySeq.get(tool.seq) ?? noTokens()
      const queue = [...step.children]
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (visited.has(id) || !/^[\w-]+$/.test(id)) continue
        visited.add(id)
        for (const child of await steps(brain, id)) {
          if (child.createdAt >= cutoff) continue
          if (child.tokens) addTokens(tokens, child.tokens)
          queue.push(...child.children)
        }
      }
      bySeq.set(tool.seq, tokens)
    }
    for (const [seq, tokens] of bySeq) {
      if (!hasTokens(tokens)) continue
      rows.push({
        conversationId: owner.id, seq, ts: invoked.find((tool) => tool.seq === seq)!.ts, userId: owner.userId, projectId: owner.projectId, agent: 'antigravity', model: owner.model ?? '',
        inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, cacheReadTokens: tokens.cacheReadTokens,
        cacheWriteTokens: tokens.cacheCreationTokens, cacheWrite1hTokens: 0, reportedCostUsd: null,
      })
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return rows
}

export async function importAntigravitySubAgentUsage(db: Db, homes: { accounts: string | null; user: string }, cutoff: number): Promise<void> {
  for (const row of await collectAntigravitySubAgentUsage(db, homes, cutoff)) {
    const inserted = db.insert(turnUsage).values(row).onConflictDoNothing().run()
    if (!inserted.changes) continue
    db.update(conversations).set({
      inputTokens: sql`${conversations.inputTokens} + ${row.inputTokens ?? 0}`,
      outputTokens: sql`${conversations.outputTokens} + ${row.outputTokens ?? 0}`,
    }).where(sql`${conversations.id} = ${row.conversationId}`).run()
  }
}
