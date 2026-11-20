import { asc, eq, sql } from 'drizzle-orm'
import { appSettings, conversations, turnUsage, type Db } from '@sillage/db'
import type { AgentKind, SillageEvent } from '@sillage/protocol'
import { userCodexHome } from '../codex-accounts/homes.js'
import { importCodexSubAgentUsage } from './codex-subagent-history.js'
import { consumedUsageOf, turnUsageOf, type ClaudeModelUsage, type ModelTurnUsage } from './turn-usage.js'

/** Bumped when the journals must be read again; the rows already there are kept. */
const HISTORY_VERSION = 1
const HISTORY_KEY = 'turnUsageHistory'
/** Codex sub-agents read back from the CLI's rollouts, apart: the journals are not read again for it. */
const SUB_AGENT_HISTORY_KEY = 'codexSubAgentUsageHistory'

interface Owner { userId: string; projectId: string | null; agent: AgentKind; model: string | null }
interface Running { model: string | null; claude: ClaudeModelUsage | null }

/**
 * Writes what each turn consumed to `turn_usage`, as turns complete, and once from the journals
 * for the turns that predate the table.
 */
export class TurnUsageRecorder {
  /** Per conversation: the model its CLI session announced, and Claude's last cumulative counters. */
  private readonly running = new Map<string, Running>()
  private history: Promise<void> | null = null

  constructor(private readonly db: Db, private readonly codexHome = userCodexHome()) {}

  /** Called for every event a runner emits, with the native payload the journal stores beside it. */
  observe(conversationId: string, entry: { seq: number; ts: number; event: SillageEvent }, raw: unknown): void {
    const { event } = entry
    if (event.type === 'session.started') {
      // The cumulative counters are kept: a restarted process shows by itself, as counters
      // going backwards, whereas this event's timing has varied across CLI versions.
      this.running.set(conversationId, { model: event.model, claude: this.running.get(conversationId)?.claude ?? null })
      return
    }
    if (event.type !== 'turn.completed' && event.type !== 'usage.consumed') return
    // Read now rather than kept from the runner's start: the session may have changed project.
    const owner = this.db
      .select({ userId: conversations.userId, projectId: conversations.projectId, agent: conversations.agent, model: conversations.model })
      .from(conversations).where(eq(conversations.id, conversationId)).get()
    if (!owner) return
    const state = this.running.get(conversationId) ?? { model: null, claude: null }
    if (event.type === 'usage.consumed') {
      this.write(conversationId, entry.seq, entry.ts, owner, consumedUsageOf(event, state.model ?? owner.model))
      return
    }
    const { rows, claude } = turnUsageOf(owner.agent, event, raw, { model: state.model ?? owner.model, claude: state.claude })
    this.running.set(conversationId, { model: state.model, claude })
    this.write(conversationId, entry.seq, entry.ts, owner, rows)
  }

  /** The runner is gone, and with it the process its counters described. */
  forget(conversationId: string): void {
    this.running.delete(conversationId)
  }

  historyReady(): boolean {
    return this.readHistoryVersion() >= HISTORY_VERSION && this.setting(SUB_AGENT_HISTORY_KEY) >= 1
  }

  /** Reads the journals once, in the background. Safe to call at every start. */
  importHistory(): Promise<void> {
    if (this.historyReady()) return Promise.resolve()
    this.history ??= this.readHistory().finally(() => { this.history = null })
    return this.history
  }

  private async readHistory(): Promise<void> {
    // Sub-agents are recorded live from now on: only what their rollouts hold before this start.
    const cutoff = Date.now()
    if (this.readHistoryVersion() < HISTORY_VERSION) await this.readJournals()
    if (this.setting(SUB_AGENT_HISTORY_KEY) < 1) {
      await importCodexSubAgentUsage(this.db, this.codexHome, cutoff)
      this.saveSetting(SUB_AGENT_HISTORY_KEY, 1)
    }
  }

  private write(conversationId: string, seq: number, ts: number, owner: Owner, rows: ModelTurnUsage[]): void {
    if (!rows.length) return
    this.db.insert(turnUsage)
      .values(rows.map((row) => ({ conversationId, seq, ts, userId: owner.userId, projectId: owner.projectId, agent: owner.agent, ...row })))
      // History and live recording may meet on a turn completed while the journals are read.
      .onConflictDoNothing()
      .run()
  }

  private async readJournals(): Promise<void> {
    const owners = this.db
      .select({ id: conversations.id, userId: conversations.userId, projectId: conversations.projectId, agent: conversations.agent, model: conversations.model })
      .from(conversations).orderBy(asc(conversations.createdAt)).all()
    /**
     * A fork starts with a copy of its source's journal, dates included: the copied turns were
     * consumed once. Conversations are read oldest first, so the source keeps them.
     */
    const seen = new Set<string>()
    for (const owner of owners) {
      const state: Running = { model: null, claude: null }
      // Only the fields read here leave SQLite: a result's `raw` also carries the whole answer.
      const entries = this.db.all<{ seq: number; ts: number; type: string; payload: string; model: string | null; turn: string | null; cumulative: string | null; written: string | null }>(sql`
        select seq, ts, type,
          case when type in ('turn.completed', 'usage.consumed') then payload else '' end as payload,
          case when type = 'session.started' then json_extract(payload, '$.model') end as model,
          json_extract(raw, '$.model_usage_since_last_result') as turn,
          json_extract(raw, '$.modelUsage') as cumulative,
          json_extract(raw, '$.usage.cache_creation') as written
        from events
        where conversation_id = ${owner.id} and type in ('turn.completed', 'usage.consumed', 'session.started')
        order by seq`)
      for (const entry of entries) {
        if (entry.type === 'session.started') {
          state.model = entry.model
          continue
        }
        if (entry.type === 'usage.consumed') {
          let consumed: Extract<SillageEvent, { type: 'usage.consumed' }>
          try { consumed = JSON.parse(entry.payload) } catch { continue }
          const copy = `${entry.ts}:${entry.payload}`
          if (seen.has(copy)) continue
          seen.add(copy)
          this.write(owner.id, entry.seq, entry.ts, owner, consumedUsageOf(consumed, state.model ?? owner.model))
          continue
        }
        let event: Extract<SillageEvent, { type: 'turn.completed' }>
        try { event = { cacheCreationTokens: 0, cacheReadTokens: 0, ...JSON.parse(entry.payload) } } catch { continue }
        const raw = entry.turn || entry.cumulative
          ? { type: 'result', model_usage_since_last_result: parse(entry.turn), modelUsage: parse(entry.cumulative), usage: { cache_creation: parse(entry.written) } }
          : null
        const { rows, claude } = turnUsageOf(owner.agent, event, raw, { model: state.model ?? owner.model, claude: state.claude })
        state.claude = claude
        const copy = `${entry.ts}:${entry.payload}`
        if (seen.has(copy)) continue
        seen.add(copy)
        this.write(owner.id, entry.seq, entry.ts, owner, rows)
      }
      // One conversation per tick: the daemon keeps serving while years of journals go by.
      await new Promise((resolve) => setImmediate(resolve))
    }
    // The stored totals added Claude's cumulative cost at every turn: replace them with the sum
    // of what each turn announced.
    this.db.run(sql`
      update conversations set cost_usd = coalesce((select sum(reported_cost_usd) from turn_usage where turn_usage.conversation_id = conversations.id), 0)
      where agent = 'claude'`)
    this.saveSetting(HISTORY_KEY, HISTORY_VERSION)
  }

  private readHistoryVersion(): number {
    return this.setting(HISTORY_KEY)
  }

  private setting(key: string): number {
    const row = this.db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).get()
    return Number(row?.value) || 0
  }

  private saveSetting(key: string, version: number): void {
    const values = { key, value: String(version), updatedAt: Date.now() }
    this.db.insert(appSettings).values(values).onConflictDoUpdate({ target: appSettings.key, set: values }).run()
  }
}

function parse(json: string | null): unknown {
  if (!json) return undefined
  try { return JSON.parse(json) } catch { return undefined }
}
