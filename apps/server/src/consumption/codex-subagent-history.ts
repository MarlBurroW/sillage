import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { sql } from 'drizzle-orm'
import { conversations, turnUsage, type Db } from '@sillage/db'

/**
 * Codex sub-agents consumed tokens that Sillage did not record before `usage.consumed`, and the
 * journal never kept their usage notifications. Codex itself writes each thread's cumulative
 * totals to its rollout (`$CODEX_HOME/sessions/…/rollout-…-<thread>.jsonl`): the sub-agents a
 * conversation started are read back from there, once.
 */

const ROLLOUT = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

interface Totals { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number }

/** Rollout path per thread id. Additional accounts link `sessions` to the main home, so one root holds them all. */
async function rollouts(codexHome: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const dir of ['sessions', 'archived_sessions']) {
    const root = join(codexHome, dir)
    let files: string[]
    try { files = await readdir(root, { recursive: true }) } catch { continue }
    for (const file of files) {
      const id = ROLLOUT.exec(file)?.[1]
      if (id && !found.has(id)) found.set(id, join(root, file))
    }
  }
  return found
}

/**
 * The thread's last totals written before `cutoff`, and its model. Later usage belongs to runners
 * that already report it live. A forked sub-agent's rollout starts with copies of its parent's
 * metadata, but its counters start from zero (probed on 0.163.0).
 */
async function readRollout(path: string, cutoff: number): Promise<{ totals: Totals; ts: number; model: string | null } | null> {
  let last: { totals: Totals; ts: number } | null = null
  let model: string | null = null
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    // Most lines are messages and tool output: only these two kinds are parsed.
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) continue
    let entry: { timestamp?: string; type?: string; payload?: { type?: string; model?: unknown; info?: { total_token_usage?: Totals } | null } }
    try { entry = JSON.parse(line) } catch { continue }
    const ts = Date.parse(entry.timestamp ?? '')
    if (!Number.isFinite(ts) || ts >= cutoff) continue
    if (entry.type === 'turn_context' && typeof entry.payload?.model === 'string') model = entry.payload.model
    const totals = entry.payload?.type === 'token_count' ? entry.payload.info?.total_token_usage : undefined
    if (totals) last = { totals, ts }
  }
  return last && { ...last, model }
}

/** One row per sub-agent thread with usage, ready for `turn_usage`. Reads, never writes. */
export async function collectCodexSubAgentUsage(db: Db, codexHome: string, cutoff: number) {
  /**
   * Sub-agents as journaled by the runner, through the `Agent` tool it opens for each: its id
   * embeds the thread (`codex-agent-<thread>-<uuid>`), and the partial tool index answers in
   * milliseconds where reading `task.started` payloads scans every journal. Oldest conversation
   * first: a fork copies its source's journal, and the thread was consumed once.
   */
  const started = db.all<{ conversationId: string; threadId: string; seq: number; userId: string; projectId: string | null; model: string | null }>(sql`
    select e.conversation_id as conversationId, substr(e.payload ->> '$.toolCallId', 13, 36) as threadId, min(e.seq) as seq,
      c.user_id as userId, c.project_id as projectId, c.model as model
    from conversations c join events e on e.conversation_id = c.id and e.type = 'tool.started'
      and (e.payload ->> '$.toolCallId') >= 'codex-agent-' and (e.payload ->> '$.toolCallId') < 'codex-agent.'
    where c.agent = 'codex'
    group by e.conversation_id, threadId
    order by c.created_at, e.conversation_id`)
  const rows: (typeof turnUsage.$inferInsert)[] = []
  if (!started.length) return rows
  const paths = await rollouts(codexHome)
  const seen = new Set<string>()
  for (const child of started) {
    if (seen.has(child.threadId)) continue
    seen.add(child.threadId)
    const path = paths.get(child.threadId)
    if (!path) continue
    const read = await readRollout(path, cutoff)
    if (!read) continue
    const { totals } = read
    const input = totals.input_tokens ?? 0
    const cached = totals.cached_input_tokens ?? 0
    const written = totals.cache_write_input_tokens ?? 0
    const output = totals.output_tokens ?? 0
    if (input + output === 0) continue
    // Keyed on the sub-agent's start event: no turn or live consumption row uses that sequence.
    rows.push({
      conversationId: child.conversationId, seq: child.seq, ts: read.ts, userId: child.userId, projectId: child.projectId,
      agent: 'codex', model: read.model ?? child.model ?? '',
      inputTokens: Math.max(0, input - cached - written), outputTokens: output, cacheReadTokens: cached,
      cacheWriteTokens: written, cacheWrite1hTokens: 0, reportedCostUsd: null,
    })
    // One rollout per tick: some run to tens of megabytes.
    await new Promise((resolve) => setImmediate(resolve))
  }
  return rows
}

export async function importCodexSubAgentUsage(db: Db, codexHome: string, cutoff: number): Promise<void> {
  for (const row of await collectCodexSubAgentUsage(db, codexHome, cutoff)) {
    const inserted = db.insert(turnUsage).values(row).onConflictDoNothing().run()
    if (!inserted.changes) continue
    db.update(conversations).set({
      inputTokens: sql`${conversations.inputTokens} + ${row.inputTokens ?? 0}`,
      outputTokens: sql`${conversations.outputTokens} + ${row.outputTokens ?? 0}`,
    }).where(sql`${conversations.id} = ${row.conversationId}`).run()
  }
}
