import { ThreadProjection } from './thread-projection.js'
import { EventEmitter } from 'node:events'
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { conversationPaths, conversations, events, writeTransaction, type Db, type Tx } from '@sillage/db'
import {
  sillageEventSchema,
  type BackgroundTask,
  type JournalEntry,
  type SillageEvent,
} from '@sillage/protocol'
import { indexConversation, indexMessage } from '../search/search-index.js'
import {
  advanceIndex,
  emptySupersessionIndex,
  INDEXED_TYPES,
  isSuperseded,
  type SupersessionIndex,
} from './superseded.js'
import { bodyPayload, bodyWeight, prepareBodyPayload } from './event-bodies.js'
import { replayPayload, replayWeight } from './tool-output.js'
import { touchedPaths } from './touched-paths.js'

/** Journal (spec invariant I2). Persist all agent output before broadcasting so clients never receive unpersisted events; reconnect replay from cursors prevents network loss. `seq` strictly increases per conversation but may have gaps after delta compaction: always read `seq > cursor`, never assume increments. */
/** Three blocking interaction types indexed by their opening events. */
const PROMPT_KINDS: Record<string, PromptKind | undefined> = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'plan.review_requested': 'plan',
  'elicitation.requested': 'elicitation',
}

const RESOLUTIONS: Record<PromptKind, string> = {
  permission: 'permission.resolved',
  question: 'question.resolved',
  plan: 'plan.review_resolved',
  elicitation: 'elicitation.resolved',
}

export type PromptKind = 'permission' | 'question' | 'plan' | 'elicitation'

/** Main-conversation turn count from journals. One per user message, matching web `buildTurns` markers; counting agent messages would count tool steps instead. Message-based rather than `turn.started`: turns may start without user input (resume, loops, plan continuation), while steering adds messages without new turns. Nearly half measured conversations differed. Displayed counts must match navigable markers, not runner lifecycle. Count distinct `messageId` because responses span multiple `message.completed`; exclude subagents with `parentToolCallId`. Recount at turn end rather than maintain extra state detecting first completions: one query suffices. */
const TURN_COUNT = sql<number>`(
  select count(distinct ${events.payload} ->> '$.messageId')
  from ${events}
  where ${events.conversationId} = ${conversations.id}
    and ${events.type} = 'message.completed'
    and ${events.payload} ->> '$.role' = 'user'
    and coalesce(${events.payload} ->> '$.parentToolCallId', '') = ''
)`

/** Events worth highlighting to readers. Mirrors session-manager `NOTIFIABLE`: agent decision requests and turn endings, plus errors relevant when revisiting. Use an explicit allowlist: service events such as `session.ended` and `usage.updated` otherwise marked 57 of 80 conversations unread after everyone left. Closed lists are auditable and do not become wrong when new service types appear. */
const NOTABLE = new Set<SillageEvent['type']>([
  'turn.completed',
  'error',
  'permission.requested',
  'question.requested',
  'elicitation.requested',
  'plan.review_requested',
  // Held session messages await human delivery or dismissal.
  'session_message.held',
])

/** Disk entry weight in bytes rather than characters: accents and emoji weigh more than `String.length` suggests. */
function byteSize(payload: string, raw: string | null): number {
  return Buffer.byteLength(payload) + (raw === null ? 0 : Buffer.byteLength(raw))
}

/** In-memory replay indexes for recently opened conversations. */
const SUPERSESSION_INDEX_BYTES = 16 * 1024 * 1024

export class EventLog {
  readonly thread: ThreadProjection
  private readonly bus = new EventEmitter()
  private readonly indexWeights = new WeakMap<SupersessionIndex, { seq: number; bytes: number }>()
  private readonly supersession = new Map<string, SupersessionIndex>()

  constructor(private readonly db: Db) {
    // Popular conversations with several mobile/desktop tabs quickly exceed
    // the default ten-listener limit.
    this.bus.setMaxListeners(200)
    this.thread = new ThreadProjection(db, this)
  }

  /** Increment `seq` and insert events in one transaction so concurrent writes cannot receive identical numbers. */
  append(
    conversationId: string,
    event: SillageEvent,
    raw?: unknown,
    rawFormat?: string,
  ): JournalEntry {
    const ts = Date.now()

    const entry = writeTransaction(this.db, (tx): JournalEntry => {
      const row = tx
        .select({ lastSeq: conversations.lastSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()

      if (!row) throw new Error(`Conversation inconnue : ${conversationId}`)
      const seq = row.lastSeq + 1

      const payload = JSON.stringify(event)
      const storedRaw = raw === undefined ? null : JSON.stringify(raw)

      tx.insert(events)
        .values({
          conversationId,
          seq,
          ts,
          type: event.type,
          payload,
          raw: storedRaw,
          rawFormat: raw === undefined ? null : (rawFormat ?? null),
        })
        .run()

      tx.update(conversations)
        .set({
          lastSeq: seq,
          ...(NOTABLE.has(event.type) ? { lastNotableSeq: seq } : {}),
          updatedAt: ts,
          journalBytes: sql`${conversations.journalBytes} + ${byteSize(payload, storedRaw)}`,
        })
        .where(eq(conversations.id, conversationId))
        .run()

      // Same transaction as journal writes: indexes cannot contain absent messages
      // or omit committed ones.
      if (event.type === 'message.completed') indexMessage(tx, conversationId, seq)
      recordTouchedPaths(tx, conversationId, event, ts)

      return { conversationId, seq, ts, event }
    })

    this.bus.emit(conversationId, entry)
    this.bus.emit(ALL_EVENTS, entry)
    this.thread.schedule(conversationId)
    return entry
  }

  /** Appends translated CLI transcript events (imports/resynchronization) with original dates in one transaction. Hundreds of individual transactions would multiply fsyncs and partial failure would silently truncate history. Broadcast per event like `append` so subscribed tabs see resynchronization live. */
  appendBatch(
    conversationId: string,
    batch: { ts: number; event: SillageEvent; raw?: unknown }[],
    /** Shared `raw` provenance for batches from one source. */
    rawFormat?: string,
    /** Persist a transcript cursor in the same commit as its translated events. */
    checkpoint?: (tx: Tx, lastSeq: number) => void,
    /** Streaming imports recount once on completion, not once per small batch. */
    recountTurns = true,
  ): number {
    if (batch.length === 0 && !checkpoint) return 0

    const entries = writeTransaction(this.db, (tx): JournalEntry[] => {
      const row = tx
        .select({ lastSeq: conversations.lastSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()
      if (!row) throw new Error(`Conversation inconnue : ${conversationId}`)

      let bytes = 0
      let notableSeq = 0
      const appended = batch.map((item, index): JournalEntry => {
        const seq = row.lastSeq + index + 1
        if (NOTABLE.has(item.event.type)) notableSeq = seq
        const payload = JSON.stringify(item.event)
        const storedRaw = item.raw === undefined ? null : JSON.stringify(item.raw)
        bytes += byteSize(payload, storedRaw)

        tx.insert(events)
          .values({
            conversationId,
            seq,
            ts: item.ts,
            type: item.event.type,
            payload,
            raw: storedRaw,
            rawFormat: item.raw === undefined ? null : (rawFormat ?? null),
          })
          .run()
        if (item.event.type === 'message.completed') indexMessage(tx, conversationId, seq)
        recordTouchedPaths(tx, conversationId, item.event, item.ts)
        return { conversationId, seq, ts: item.ts, event: item.event }
      })

      checkpoint?.(tx, row.lastSeq + batch.length)

      // Repeated full-journal counts would make a bounded streaming import quadratic.
      if (batch.length || recountTurns) tx.update(conversations)
        .set({
          lastSeq: row.lastSeq + batch.length,
          ...(notableSeq > 0 ? { lastNotableSeq: notableSeq } : {}),
          updatedAt: Date.now(),
          journalBytes: sql`${conversations.journalBytes} + ${bytes}`,
          ...(recountTurns ? { turnCount: TURN_COUNT } : {}),
        })
        .where(eq(conversations.id, conversationId))
        .run()

      return appended
    })

    for (const entry of entries) this.bus.emit(conversationId, entry)
    if (entries.length) this.thread.schedule(conversationId)
    return entries.at(-1)?.seq ?? 0
  }

  /** Markers aligning journals with CLI transcripts. `uuids` are known transcript IDs retained in live/import `raw` fields; the latest shared ID identifies resumption. `startedToolCallIds` and `completedToolCallIds` prevent duplicate tools whose transcript entries lie after that point following interrupted turns. `subAgentIds` distinguishes already journaled children from new files when a child has no matching UUID. Claude contract: only Claude Code writes transcript `raw.uuid`; Codex raw payloads lack it, making reads harmless elsewhere but meaningful only to Claude adapters. */
  importAnchors(conversationId: string): {
    uuids: Set<string>
    startedToolCallIds: Set<string>
    completedToolCallIds: Set<string>
    subAgentIds: Set<string>
  } {
    // Only identifiers cross into JS: native raw and normalized bodies can each
    // exceed the daemon heap on long conversations.
    const rows = this.db
      .select({
        type: events.type,
        uuid: sql<string | null>`case when json_valid(${events.raw}) and json_type(${events.raw}, '$.uuid') = 'text' then ${events.raw} ->> '$.uuid' end`,
        toolCallId: sql<string | null>`case when json_type(${events.payload}, '$.toolCallId') = 'text' then ${events.payload} ->> '$.toolCallId' end`,
        parentToolCallId: sql<string | null>`case when json_type(${events.payload}, '$.parentToolCallId') = 'text' then ${events.payload} ->> '$.parentToolCallId' end`,
      })
      .from(events)
      .where(eq(events.conversationId, conversationId))
      .all()

    const uuids = new Set<string>()
    const startedToolCallIds = new Set<string>()
    const completedToolCallIds = new Set<string>()
    const subAgentIds = new Set<string>()
    for (const row of rows) {
      if (typeof row.uuid === 'string') uuids.add(row.uuid)
      if (row.type === 'tool.started' && typeof row.toolCallId === 'string') startedToolCallIds.add(row.toolCallId)
      if (row.type === 'tool.completed' && typeof row.toolCallId === 'string') completedToolCallIds.add(row.toolCallId)
      if (typeof row.parentToolCallId === 'string') subAgentIds.add(row.parentToolCallId)
    }
    return { uuids, startedToolCallIds, completedToolCallIds, subAgentIds }
  }

  read(conversationId: string, afterSeq: number, limit: number): JournalEntry[] {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, conversationId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
      .limit(limit)
      .all()

    return rows.map((row) => ({
      conversationId: row.conversationId,
      seq: row.seq,
      ts: row.ts,
      event: this.parseStored(row.seq, row.payload),
    }))
  }

  /** History replay pages exclude superseded entries (`superseded.ts`) and large tool outputs (`tool-output.ts`), bounded by both bytes and rows. First list rows without contents (`octet_length` avoids loading payloads), then read and validate retained rows only: discarded patches never leave disk. Byte bounds protect daemon heaps: two thousand consecutive rows can weigh 141 MB although most pages occupy hundreds of KB. Always retain at least one event so oversized events can progress. `nextAfter` is the last examined sequence whether retained or not. */
  readForReplay(
    conversationId: string,
    afterSeq: number,
    limits: { rows: number; bytes: number; bodies?: boolean; unfiltered?: boolean },
  ): { entries: JournalEntry[]; nextAfter: number } {
    // Returning to an unchanged projected thread needs no historical supersession index.
    const lastSeq = this.db.select({ seq: conversations.lastSeq }).from(conversations).where(eq(conversations.id, conversationId)).get()?.seq ?? 0
    if (afterSeq >= lastSeq) return { entries: [], nextAfter: afterSeq }
    const index = limits.unfiltered ? null : this.supersessionIndex(conversationId)
    const listed = this.db
      .select({
        seq: events.seq,
        type: events.type,
        bytes: limits.bodies ? bodyWeight : replayWeight,
        toolCallId: sql<string | null>`case when ${events.type} = 'tool.output_delta'
          then ${events.payload} ->> '$.toolCallId' end`,
      })
      .from(events)
      .where(and(eq(events.conversationId, conversationId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
      .limit(limits.rows)
      .all()

    const kept: number[] = []
    let bytes = 0
    let nextAfter = afterSeq
    for (const row of listed) {
      if (!index || !isSuperseded(index, row)) {
        if (kept.length > 0 && bytes + row.bytes > limits.bytes) break
        kept.push(row.seq)
        bytes += row.bytes
      }
      nextAfter = row.seq
    }

    if (kept.length === 0) return { entries: [], nextAfter }

    const rows = this.db
      .select({ seq: events.seq, ts: events.ts, payload: limits.bodies ? bodyPayload : replayPayload })
      .from(events)
      .where(and(eq(events.conversationId, conversationId), inArray(events.seq, kept)))
      .orderBy(asc(events.seq))
      .all()

    return {
      entries: rows.map((row) => ({
        conversationId,
        seq: row.seq,
        ts: row.ts,
        event: this.parseStored(row.seq, row.payload, limits.bodies),
      })),
      nextAfter,
    }
  }

  /** Socket catch-up keeps all sequence numbers but shares REST's lightweight representation. */
  readWithBodies(conversationId: string, afterSeq: number, limit: number): JournalEntry[] {
    return this.db.select({ seq: events.seq, ts: events.ts, payload: bodyPayload })
      .from(events).where(and(eq(events.conversationId, conversationId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq)).limit(limit).all().map((row) => ({
        conversationId, seq: row.seq, ts: row.ts,
        event: this.parseStored(row.seq, row.payload, true),
      }))
  }

  /** Live events were persisted before broadcasting; project that exact row, never a later call. */
  withBodies(entry: JournalEntry): JournalEntry {
    if (!['message.completed', 'tool.started', 'tool.input_updated', 'tool.completed', 'diff.updated'].includes(entry.event.type)) return entry
    return this.readWithBodies(entry.conversationId, entry.seq - 1, 1)[0] ?? entry
  }

  eventBody(conversationId: string, seq: number, field: 'input' | 'output' | 'patch', block?: number): { value: unknown } | null {
    const path = block === undefined ? `$.${field}` : `$.blocks[${block}].${field}`
    const row = this.db.select({ value: sql<string | null>`${events.payload} -> ${path}`,
      type: events.type, blockType: sql<string | null>`${events.payload} ->> ${block === undefined ? '$.type' : `$.blocks[${block}].type`}` })
      .from(events).where(and(eq(events.conversationId, conversationId), eq(events.seq, seq))).get()
    if (!row || row.value === null) return null
    const allowed = block === undefined
      ? (field === 'input' && ['tool.started', 'tool.input_updated'].includes(row.type)) || (field === 'output' && row.type === 'tool.completed') || (field === 'patch' && row.type === 'diff.updated')
      : row.type === 'message.completed' && ((field === 'input' && row.blockType === 'tool_use') || (field === 'output' && row.blockType === 'tool_result'))
    return allowed ? { value: JSON.parse(row.value) } : null
  }

  eventImage(conversationId: string, seq: number, block: number): string | null {
    const row = this.db.select({ url: sql<string | null>`${events.payload} ->> ${`$.blocks[${block}].url`}` })
      .from(events).where(and(eq(events.conversationId, conversationId), eq(events.seq, seq),
        eq(events.type, 'message.completed'), sql`${events.payload} ->> ${`$.blocks[${block}].type`} = 'image'`)).get()
    return row?.url ?? null
  }

  /** Conversation supersession index current through its latest `seq`. Build once (44 ms on the largest conversation), then advance each page using only new events; rescanning later history per page would erase savings. */
  private supersessionIndex(conversationId: string): SupersessionIndex {
    const lastSeq =
      this.db
        .select({ lastSeq: conversations.lastSeq })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .get()?.lastSeq ?? 0

    let index = this.supersession.get(conversationId)
    // Journals shrink only through out-of-daemon resets: restart indexes from scratch
    // instead of filtering against nonexistent history.
    if (!index || index.seq > lastSeq) index = emptySupersessionIndex()

    if (lastSeq > index.seq) {
      const rows = this.db
        .select({
          seq: events.seq,
          type: events.type,
          toolCallId: sql<string | null>`case when ${events.type} = 'tool.completed'
            then ${events.payload} ->> '$.toolCallId' end`,
        })
        .from(events)
        .where(
          and(
            eq(events.conversationId, conversationId),
            gt(events.seq, index.seq),
            lte(events.seq, lastSeq),
            inArray(events.type, INDEXED_TYPES),
          ),
        )
        .orderBy(asc(events.seq))
        .all()
      advanceIndex(index, rows, lastSeq)
    }

    // Reinsert to move to the end: `Map` preserves insertion order,
    // so the first key is least recently read.
    this.supersession.delete(conversationId)
    this.supersession.set(conversationId, index)
    if (this.indexWeights.get(index)?.seq !== index.seq) {
      let weight = 128 + conversationId.length * 2 + index.diffTurn.size * 48 + index.turnDiffs.size * 80
      for (const key of index.completed.keys()) weight += 64 + key.length * 2
      this.indexWeights.set(index, { seq: index.seq, bytes: weight })
    }
    let bytes = 0
    for (const [id, cached] of [...this.supersession].reverse()) {
      bytes += this.indexWeights.get(cached)?.bytes ?? 0
      if (bytes > SUPERSESSION_INDEX_BYTES) this.supersession.delete(id)
    }
    return index
  }

  /** Latest events of selected types, newest first. Replaying entire journals to report present state would pay full-history costs on every call. Recent entries suffice, bounded by `limit`. */
  latest(conversationId: string, types: string[], limit: number): JournalEntry[] {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, conversationId), inArray(events.type, types)))
      .orderBy(desc(events.seq))
      .limit(limit)
      .all()

    return rows.map((row) => ({
      conversationId: row.conversationId,
      seq: row.seq,
      ts: row.ts,
      event: this.parseStored(row.seq, row.payload),
    }))
  }

  /** Latest main-agent text addressed to users, retained by noninterface callers such as webhooks and subsequent scheduled runs. */
  lastAssistantText(conversationId: string): string | null {
    const entries = this.latest(conversationId, ['message.completed'], 20)
    for (const entry of entries) {
      const event = entry.event as {
        role?: string
        parentToolCallId?: string | null
        blocks?: { type: string; text?: string }[]
      }
      if (event.role !== 'assistant' || event.parentToolCallId !== null) continue
      const text = (event.blocks ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) return text
    }
    return null
  }

  /** Reconciles turn counts with journals at turn completion, when all messages are persisted. Once per turn suffices for sidebar rows. */
  refreshTurnCount(conversationId: string): void {
    this.db
      .update(conversations)
      .set({ turnCount: TURN_COUNT })
      .where(eq(conversations.id, conversationId))
      .run()
  }

  /** Counts events by type without loading them. */
  count(conversationId: string, type: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(and(eq(events.conversationId, conversationId), eq(events.type, type)))
      .get()

    return row?.n ?? 0
  }

  /** Unresolved interaction requests lacking journaled resolutions. Abruptly killed daemons skip runner cleanup, leaving pending requests open. This inventory prevents replay from displaying permanent questions and stuck waiting conversations. */
  openPrompts(conversationId: string): { kind: PromptKind; requestId: string }[] {
    const rows = this.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          inArray(events.type, [...Object.keys(PROMPT_KINDS), ...Object.values(RESOLUTIONS)]),
        ),
      )
      .orderBy(asc(events.seq))
      .all()

    const open = new Map<string, PromptKind>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { requestId?: string }
      if (typeof payload.requestId !== 'string') continue

      const kind = PROMPT_KINDS[row.type]
      if (kind) open.set(payload.requestId, kind)
      else open.delete(payload.requestId)
    }

    return [...open].map(([requestId, kind]) => ({ kind, requestId }))
  }

  /** Asynchronous questions may remain open while conversations are idle. */
  openAsyncQuestionConversationIds(): string[] {
    return this.db.selectDistinct({ id: events.conversationId }).from(events).where(sql`
      ${events.type} = 'question.requested' AND ${events.payload} ->> '$.blocking' = 0
      AND NOT EXISTS (
        SELECT 1 FROM events AS resolved
        WHERE resolved.conversation_id = ${events.conversationId}
          AND resolved.type = 'question.resolved'
          AND resolved.seq > ${events.seq}
          AND resolved.payload ->> '$.requestId' = ${events.payload} ->> '$.requestId'
      )
    `).all().map((row) => row.id)
  }

  /** Background work journals still report alive. Like `openPrompts` for top-level lists: CLIs publish complete lists on change but nothing when dying, so the last list remains authoritative for display and identifies work needing closure. Replay using web fold semantics: lists replace, task endings remove, session endings clear everything. */
  openBackgroundTasks(conversationId: string): BackgroundTask[] {
    const rows = this.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          inArray(events.type, ['background.updated', 'task.completed', 'session.ended']),
        ),
      )
      .orderBy(asc(events.seq))
      .all()

    let live = new Map<string, BackgroundTask>()
    for (const row of rows) {
      if (row.type === 'session.ended') {
        live.clear()
        continue
      }

      const payload = JSON.parse(row.payload) as { tasks?: BackgroundTask[]; taskId?: string }
      if (row.type === 'background.updated') {
        live = new Map((payload.tasks ?? []).map((task) => [task.id, task]))
      } else if (typeof payload.taskId === 'string') {
        live.delete(payload.taskId)
      }
    }

    return [...live.values()]
  }

  /** Copies journal prefixes into forked conversations. Copy `raw` too because later forks need transcript identifiers (invariant I3). Renumber `seq` from 1 for the new conversation. Without this copy, displayed forks would be empty while agents remember history, violating invariant I2. */
  copyThrough(fromConversationId: string, toConversationId: string, throughSeq: number): number {
    const rows = this.db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, fromConversationId), lte(events.seq, throughSeq)))
      .orderBy(asc(events.seq))
      .all()

    writeTransaction(this.db, (tx) => {
      let bytes = 0
      rows.forEach((row, index) => {
        bytes += byteSize(row.payload, row.raw)
        tx.insert(events)
          .values({
            conversationId: toConversationId,
            seq: index + 1,
            ts: row.ts,
            type: row.type,
            payload: row.payload,
            raw: row.raw,
            rawFormat: row.rawFormat,
          })
          .run()
      })

      tx.update(conversations)
        .set({ lastSeq: rows.length, journalBytes: bytes, turnCount: TURN_COUNT })
        .where(eq(conversations.id, toConversationId))
        .run()

      // Copying bypasses `append`: without this line, forks would remain
      // unfindable in search despite retaining complete thread contents.
      indexConversation(tx, toConversationId)
    })

    return rows.length
  }

  /** Latest native payload of a given type through `throughSeq`. Claude forks use transcript cut-point identifiers available only in `raw`. `topLevelOnly` excludes subagent events carrying `parentToolCallId`: their sidechain raw entries target different files. Legacy events without the field remain included. */
  lastRawOfType(
    conversationId: string,
    type: string,
    throughSeq: number,
    opts: { topLevelOnly?: boolean } = {},
  ): unknown {
    const conditions = [
      eq(events.conversationId, conversationId),
      eq(events.type, type),
      lte(events.seq, throughSeq),
    ]
    if (opts.topLevelOnly) {
      conditions.push(sql`coalesce(${events.payload} ->> '$.parentToolCallId', '') = ''`)
    }

    const row = this.db
      .select({ raw: events.raw })
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.seq))
      .limit(1)
      .get()

    return row?.raw ? JSON.parse(row.raw) : null
  }

  /** Full tool output, reduced to previews beyond replay size thresholds. Filter `toolCallId` in SQLite: `rawOfTool` below loads and parses every conversation call to select one, costly for thousands of calls. */
  toolOutput(conversationId: string, toolCallId: string): { output: unknown } | null {
    const row = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          eq(events.type, 'tool.completed'),
          sql`${events.payload} ->> '$.toolCallId' = ${toolCallId}`,
        ),
      )
      .orderBy(desc(events.seq))
      .limit(1)
      .get()

    if (!row) return null
    return { output: (JSON.parse(row.payload) as { output?: unknown }).output ?? null }
  }

  /** Native payloads from tool start and completion. Hold file-edit details absent from normalized schemas: written/replaced content for Claude and unified patches for Codex. Still respects invariant I3: relevant CLI adapters interpret these, never frontends. */
  rawOfTool(conversationId: string, toolCallId: string): { started: unknown; completed: unknown } {
    const latest = (type: 'tool.started' | 'tool.completed'): unknown => {
      // A single diff previously loaded every tool payload (hundreds of MB) into JS.
      // Keep the last native event of each kind, including when a call ID is reused.
      const row = this.db
        .select({ raw: events.raw })
        .from(events)
        .where(and(
          eq(events.conversationId, conversationId),
          eq(events.type, type),
          sql`nullif(${events.raw}, '') is not null`,
          sql`${events.payload} ->> '$.toolCallId' = ${toolCallId}`,
        ))
        .orderBy(desc(events.seq))
        .limit(1)
        .get()

      return row?.raw ? JSON.parse(row.raw) : null
    }
    return { started: latest('tool.started'), completed: latest('tool.completed') }
  }

  /** Journaled change type for a call/file pair. Reread rather than trust clients because it determines full creations versus rewrites without comparison points; journals are authoritative (invariant I2). */
  fileEditAction(
    conversationId: string,
    toolCallId: string,
    path: string,
  ): 'created' | 'modified' | 'deleted' | null {
    const rows = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.conversationId, conversationId), eq(events.type, 'file.edited')))
      .all()

    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        toolCallId?: string
        path?: string
        action?: 'created' | 'modified' | 'deleted'
      }
      if (payload.toolCallId === toolCallId && payload.path === path) return payload.action ?? null
    }
    return null
  }

  /** Counts events of a type before and after cut points. */
  countByType(conversationId: string, type: string, throughSeq: number): { kept: number; total: number } {
    const rows = this.db
      .select({ seq: events.seq })
      .from(events)
      .where(and(eq(events.conversationId, conversationId), eq(events.type, type)))
      .all()

    return {
      kept: rows.filter((row) => row.seq <= throughSeq).length,
      total: rows.length,
    }
  }

  /** Queued messages whose departure was never journaled. Distinct from `openPrompts`: keys are `queueId`, resolutions contain departure reasons rather than decisions. */
  openQueuedMessages(conversationId: string): string[] {
    const rows = this.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.conversationId, conversationId),
          inArray(events.type, ['message.queued', 'message.dequeued']),
        ),
      )
      .orderBy(asc(events.seq))
      .all()

    const open = new Set<string>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { queueId?: string }
      if (typeof payload.queueId !== 'string') continue
      if (row.type === 'message.queued') open.add(payload.queueId)
      else open.delete(payload.queueId)
    }

    return [...open]
  }

  /** Validate events during replay rather than merely cast them. Applies schema defaults to entries predating fields: indefinitely replayable journals (invariant I2) must render old forms correctly instead of producing `NaN`. */
  private parseStored(seq: number, payload: string, bodies = false): SillageEvent {
    const raw: unknown = bodies ? prepareBodyPayload(payload) : JSON.parse(payload)
    const parsed = sillageEventSchema.safeParse(raw)
    if (parsed.success) return parsed.data

    // Replace irrecoverable events with visible conversation errors:
    // hiding them would leave silent history gaps.
    return {
      type: 'error',
      code: 'event_unreadable',
      message: `Event ${seq} is unreadable (${parsed.error.issues[0]?.message ?? 'unknown shape'}).`,
      recoverable: true,
    }
  }

  subscribe(conversationId: string, listener: (entry: JournalEntry) => void): () => void {
    this.bus.on(conversationId, listener)
    return () => this.bus.off(conversationId, listener)
  }

  /** All conversations for cross-cutting consumers such as webhooks. Deliberately excluded from `appendBatch`: transcript replay is not activity, and per-import notifications would flood callers with days-old turns. */
  subscribeAll(listener: (entry: JournalEntry) => void): () => void {
    this.bus.on(ALL_EVENTS, listener)
    return () => this.bus.off(ALL_EVENTS, listener)
  }
}

/** Bus channel for cross-conversation subscribers, unreachable by conversation IDs. */
const ALL_EVENTS = Symbol('all-events')

/** Stores outside-cwd paths exposed by events (see `touched-paths.ts`) within journal transactions. Worktree views read these instead of rescanning events and cannot observe paths absent from journals. */
function recordTouchedPaths(
  tx: Tx,
  conversationId: string,
  event: SillageEvent,
  ts: number,
): void {
  for (const path of touchedPaths(event)) {
    tx.insert(conversationPaths)
      .values({ conversationId, path, lastTs: ts })
      .onConflictDoUpdate({
        target: [conversationPaths.conversationId, conversationPaths.path],
        set: { lastTs: sql`max(${conversationPaths.lastTs}, ${ts})` },
      })
      .run()
  }
}
