import { setImmediate as yieldLoop } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { writeTransaction, type Db } from '@sillage/db'
import {
  applyEvent, emptyChatState, serializeChatState, deserializeChatState,
  type ChatItem, type ChatState, type SerializedChatState, type ThreadPage,
} from '@sillage/protocol/chat-state'
import type { EventLog } from './event-log.js'
import { coalesceDeltas } from './coalesce.js'

/** Bump whenever fold semantics or the stored projection format change. */
export const THREAD_PROJECTION_VERSION = 3
const PAGE_ITEMS = 200
const PAGE_BYTES = 512 * 1024
const BATCH_ROWS = 256
interface Header { version: number; cursor: number; state: string }
interface Row {
  category: 'item' | 'task' | 'edit' | 'checkpoint'
  position: number
  entry_key: string
  payload: string
}

/** One bounded batch at a time, including for existing journals. No startup-wide migration. */
export class ThreadProjection {
  private queue = new Set<string>()
  private working = false
  private stopped = false
  private errors = new Map<string, number>()
  constructor(private db: Db, private log: EventLog) {}

  stop(): void { this.stopped = true; this.queue.clear() }

  schedule(id: string): void {
    if (this.stopped || this.queue.size >= 32 || (this.errors.get(id) ?? 0) > Date.now()) return
    this.queue.add(id)
    if (!this.working) {
      this.working = true
      setTimeout(() => void this.drain(), 60).unref()
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.size && !this.stopped) {
        const id = this.queue.values().next().value!
        this.queue.delete(id)
        try {
          if (!this.advance(id)) this.queue.add(id)
        } catch {
          // A closing/deleted database or an incompatible cache must never break journal writes.
          // Back off; the next explicit opening can retry without an unbounded error log.
          this.errors.set(id, Date.now() + 5000)
          if (this.errors.size > 32) this.errors.delete(this.errors.keys().next().value!)
        }
        await yieldLoop()
      }
    } finally { this.working = false }
  }

  private header(id: string): Header | undefined {
    return this.db.get<Header>(sql`select version, cursor, state from thread_projections where conversation_id=${id}`)
  }
  private target(id: string): number | undefined {
    return this.db.get<{ last_seq: number }>(sql`select last_seq from conversations where id=${id}`)?.last_seq
  }

  /** Public for offline verification. Each successful transaction is a restart-safe checkpoint. */
  advance(id: string): boolean {
    const target = this.target(id)
    if (target === undefined) return true
    let header = this.header(id)
    if (!header || header.version !== THREAD_PROJECTION_VERSION || header.cursor > target) {
      writeTransaction(this.db, (tx) => {
        tx.run(sql`delete from thread_projection_rows where conversation_id=${id}`)
        tx.run(sql`insert or replace into thread_projections values (${id}, ${THREAD_PROJECTION_VERSION}, 0, ${JSON.stringify(serializeChatState(emptyChatState()))})`)
      })
      header = this.header(id)!
    }
    if (header.cursor >= target) return true
    // Building the disposable view must not first scan a whole-journal supersession index.
    const page = this.log.readForReplay(id, header.cursor, { rows: BATCH_ROWS, bytes: 1024 * 1024, bodies: true, unfiltered: true })
    if (page.nextAfter <= header.cursor) return true
    const entries = coalesceDeltas(page.entries)
    const keys = new Set<string>()
    for (const { event } of entries) {
      for (const key of ['messageId', 'toolCallId', 'requestId', 'taskId', 'id', 'key'] as const) {
        if (key in event) keys.add(String((event as unknown as Record<string, unknown>)[key]))
      }
      if (event.type === 'background.updated') for (const task of event.tasks) keys.add(task.id)
    }
    let state = deserializeChatState(JSON.parse(header.state) as SerializedChatState)
    if (state.planId) keys.add(state.planId)
    if (state.diffId) keys.add(state.diffId)
    const wanted = JSON.stringify([...keys])
    // Last user/edit supply turn attribution. Live rows include nonblocking questions, unfinished
    // checkpoints and tools; targeted historical rows handle late/reused native identifiers.
    const rows = this.db.all<Row>(sql`
      select * from thread_projection_rows where conversation_id=${id} and live=1
      union select * from thread_projection_rows where conversation_id=${id} and entry_key in (select value from json_each(${wanted}))
      union select * from thread_projection_rows where conversation_id=${id} and category='task' and related in (select value from json_each(${wanted}))
      union select * from (select * from thread_projection_rows where conversation_id=${id} and category='item' order by position desc limit 1)
      union select * from (select * from thread_projection_rows where conversation_id=${id} and item_kind='user' order by position desc limit 1)
      union select * from (select * from thread_projection_rows where conversation_id=${id} and category='edit' order by position desc limit 1)
      order by position`)
    state = hydrate(state, rows)
    // Background snapshots ask about spawning calls that need not occur in this batch.
    const toolKeys = JSON.stringify([...state.tasks.values()].flatMap((task) => task.toolCallId ? [task.toolCallId] : []))
    const taskTools = this.db.all<Row>(sql`select * from thread_projection_rows where conversation_id=${id} and category='item' and entry_key in (select value from json_each(${toolKeys}))`)
    const knownPositions = new Set(state.items.map((item) => item.position))
    for (const row of taskTools) if (!knownPositions.has(row.position)) { state.items.push(JSON.parse(row.payload) as ChatItem); rows.push(row) }
    state.items.sort((a, b) => a.position! - b.position!)
    const original = new Map(rows.map((row) => [`${row.category}:${row.position}`, row.payload]))
    const positions = new Map(rows.map((row) => [`${row.category}:${row.entry_key}`, row.position]))
    const changed = new Map<string, { category: Row['category']; position: number; value: unknown; updated: number }>()
    const collect = (category: Row['category'], values: { key: string; position?: number; value: unknown }[], seq: number) => {
      for (const entry of values) {
        const lookup = `${category}:${entry.key}`
        const position = entry.position ?? positions.get(lookup) ?? seq
        positions.set(lookup, position)
        changed.set(`${category}:${position}`, { category, position, value: entry.value, updated: seq })
      }
    }
    for (const { seq, ts, event } of entries) {
      state = applyEvent(state, seq, ts, event)
      collect('item', state.items.map((value) => ({ key: value.id, position: value.position, value })), seq)
      collect('task', [...state.tasks.values()].map((value) => ({ key: value.id, value })), seq)
      collect('edit', state.editTurns.map((value) => ({ key: value.id, value })), seq)
      collect('checkpoint', state.checkpoints.map((value) => ({ key: value.key, position: value.seq, value })), seq)
    }
    writeTransaction(this.db, (tx) => {
      for (const [key, row] of changed) {
        const payload = JSON.stringify(row.value)
        if (payload === original.get(key)) continue
        const info = describeRow(row.category, row.value)
        tx.run(sql`insert into thread_projection_rows
          (conversation_id,category,position,entry_key,item_kind,related,live,updated_seq,bytes,payload)
          values (${id},${row.category},${row.position},${info.key},${info.kind},${info.related},${info.live},${row.updated},${Buffer.byteLength(payload)},${payload})
          on conflict(conversation_id,category,position) do update set payload=excluded.payload, live=excluded.live,
          related=excluded.related, item_kind=excluded.item_kind, updated_seq=excluded.updated_seq, bytes=excluded.bytes`)
      }
      const scalar = serializeChatState({ ...state, items: [], tasks: new Map(), editTurns: [], checkpoints: [] })
      tx.run(sql`update thread_projections set cursor=${page.nextAfter}, state=${JSON.stringify(scalar)} where conversation_id=${id}`)
    })
    return page.nextAfter >= target
  }

  page(id: string, before = Number.MAX_SAFE_INTEGER, after?: number): ThreadPage {
    const target = this.target(id) ?? 0
    if ((this.errors.get(id) ?? 0) > Date.now()) return { building: true, cursor: 0, target, unavailable: true }
    const header = this.header(id)
    if (!header || header.version !== THREAD_PROJECTION_VERSION || header.cursor < target || header.cursor > target) {
      this.schedule(id)
      return { building: true, cursor: header?.cursor ?? 0, target }
    }
    const reset = after !== undefined && (after > header.cursor || this.db.get<{ n: number }>(sql`select count(*) n from (select 1 from thread_projection_rows where conversation_id=${id} and updated_seq>${after} limit 2001)`)!.n > 2000)
    if (reset) before = Number.MAX_SAFE_INTEGER
    const candidates = this.db.all<Row & { bytes: number; item_kind: string }>(sql`select * from thread_projection_rows where conversation_id=${id} and category='item' and position<${before} order by position desc limit ${PAGE_ITEMS}`)
    const page: Row[] = []
    let bytes = 0
    let turns = 0
    for (const row of candidates) {
      if (page.length && bytes + row.bytes > PAGE_BYTES) break
      page.push(row); bytes += row.bytes
      if (row.item_kind === 'user' && ++turns >= 6) break
    }
    const first = page.at(-1)?.position ?? before
    const updates = after === undefined || reset ? [] : this.db.all<Row>(sql`select * from thread_projection_rows where conversation_id=${id} and updated_seq>${after}`)
    const rows = new Map([...page, ...updates].map((row) => [`${row.category}:${row.position}`, row]))
    const add = (entries: Row[]) => { for (const row of entries) rows.set(`${row.category}:${row.position}`, row) }
    add(this.db.all<Row>(sql`select * from thread_projection_rows where conversation_id=${id} and live=1`))
    // Metadata follows the loaded slice. Completed history is fetched with older turns.
    const keys = JSON.stringify([...rows.values()].filter((row) => row.category === 'item').map((row) => row.entry_key))
    add(this.db.all<Row>(sql`select * from thread_projection_rows where conversation_id=${id} and category!='item' and (position>=${first} or entry_key in (select value from json_each(${keys})) or related in (select value from json_each(${keys})))`))
    const scalar = deserializeChatState(JSON.parse(header.state) as SerializedChatState)
    const contextKeys = JSON.stringify([scalar.planId, scalar.diffId])
    add(this.db.all<Row>(sql`select * from thread_projection_rows where conversation_id=${id} and category='item' and entry_key in (select value from json_each(${contextKeys}))`))
    add(this.db.all<Row>(sql`select * from thread_projection_rows where conversation_id=${id} and item_kind='user' order by position desc limit 1`))
    const visited = new Set<string>()
    for (;;) {
      const parents = [...new Set([...rows.values()].flatMap((row) => {
        const item = JSON.parse(row.payload) as { parentToolCallId?: string; toolCallId?: string }
        return [item.parentToolCallId, item.toolCallId].filter((key): key is string => !!key && !visited.has(key))
      }))]
      if (!parents.length) break
      for (const key of parents) visited.add(key)
      const keys = JSON.stringify(parents)
      add(this.db.all<Row>(sql`select * from thread_projection_rows where conversation_id=${id} and category='item' and entry_key in (select value from json_each(${keys}))`))
    }
    const toolKeys = JSON.stringify([...rows.values()].filter((row) => row.category === 'item').map((row) => row.entry_key))
    add(this.db.all<Row>(sql`select * from thread_projection_rows where conversation_id=${id} and category='task' and related in (select value from json_each(${toolKeys}))`))
    const state = hydrate(scalar, [...rows.values()].sort((a,b) => a.position-b.position))
    return { building: false, state: serializeChatState(state), cursor: header.cursor, before: first,
      hasMore: !!this.db.get(sql`select 1 from thread_projection_rows where conversation_id=${id} and category='item' and position<${first} limit 1`), reset }
  }
}

function hydrate(state: ChatState, rows: Row[]): ChatState {
  for (const row of rows) {
    const value = JSON.parse(row.payload)
    switch (row.category) {
      case 'item': state.items.push(value); break
      case 'task': state.tasks.set(value.id, value); break
      case 'edit': state.editTurns.push(value); break
      case 'checkpoint': state.checkpoints.push(value); break
    }
  }
  return state
}

function describeRow(category: Row['category'], value: unknown): { key: string; kind: string; related: string | null; live: number } {
  if (category === 'item') {
    const item = value as ChatItem
    return { key: item.id, kind: item.kind === 'message' ? item.role : item.kind,
      related: 'parentToolCallId' in item ? item.parentToolCallId : null,
      live: Number(('status' in item && (item.status === 'pending' || item.status === 'running')) ||
        (item.kind === 'message' && !!(item.streamingText || item.streamingThinking))) }
  }
  if (category === 'task') {
    const task = value as ChatState['tasks'] extends Map<string, infer T> ? T : never
    return { key: task.id, kind: category, related: task.toolCallId, live: Number(!task.done) }
  }
  if (category === 'checkpoint') {
    const checkpoint = value as ChatState['checkpoints'][number]
    return { key: checkpoint.key, kind: category, related: checkpoint.openerId, live: Number(checkpoint.openerId === null || checkpoint.status === 'pending') }
  }
  const edit = value as ChatState['editTurns'][number]
  return { key: edit.id, kind: category, related: edit.id, live: 0 }
}
