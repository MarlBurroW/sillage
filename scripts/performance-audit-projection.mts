import { createHash } from 'node:crypto'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { openDatabase, runMigrations } from '../packages/db/src/index.js'
import { EventLog } from '../apps/server/src/events/event-log.js'
import { ThreadProjection } from '../apps/server/src/events/thread-projection.js'
import { applyEvent, emptyChatState, deserializeChatState, serializeChatState, type ChatState } from '../packages/protocol/src/chat-state.js'
import { coalesceDeltas } from '../apps/server/src/events/coalesce.js'
import { fileURLToPath } from 'node:url'

// Only the disposable, trimmed audit database may be mutated by this probe.
const database = process.argv[2]!
if (!database.startsWith('/var/tmp/sillage-perf-audit-')) throw Error('Use the audit fixture')
const { db, sqlite } = openDatabase(database)
runMigrations(db, fileURLToPath(new URL('../packages/db/migrations', import.meta.url)))
const log = new EventLog(db)
log.thread.stop()
if (process.env.AUDIT_REBUILD === '1') sqlite.prepare('update thread_projections set version=-1').run()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normal = (state: ChatState) => { const wire = serializeChatState(state); wire.tasks.sort((a,b) => a[0].localeCompare(b[0])); return wire }
for (const [index, id] of process.argv.slice(3).entries()) {
  const projection = new ThreadProjection(db, log)
  const started = performance.now()
  let maxBatchMs = 0, batches = 0
  for (;;) {
    const tick = performance.now()
    const done = projection.advance(id)
    maxBatchMs = Math.max(maxBatchMs, performance.now()-tick); batches++
    if (done) break
    await yieldLoop()
  }
  const buildMs = performance.now()-started
  const tick = performance.now()
  let page = projection.page(id)
  if (page.building) throw Error('Projection not ready')
  const readyMs = performance.now()-tick
  const bytes = Buffer.byteLength(JSON.stringify(page))
  let state = deserializeChatState(page.state)
  while (page.hasMore) {
    page = projection.page(id, page.before, page.cursor)
    if (page.building) throw Error('Projection not ready')
    const next = deserializeChatState(page.state)
    state = { ...next,
      items: [...new Map([...state.items,...next.items].map((v) => [v.position,v])).values()].sort((a,b) => a.position!-b.position!),
      tasks: new Map([...state.tasks,...next.tasks]),
      checkpoints: [...new Map([...state.checkpoints,...next.checkpoints].map((v) => [v.key,v])).values()].sort((a,b) => a.seq-b.seq),
      editTurns: [...new Map([...state.editTurns,...next.editTurns].map((v) => [v.id,v])).values()].sort((a,b) => a.seq!-b.seq!),
    }
  }
  let reference = emptyChatState(), cursor = 0
  for (;;) {
    const page = log.readForReplay(id, cursor, { rows: 256, bytes: 1024*1024, bodies: true })
    for (const { seq, ts, event } of coalesceDeltas(page.entries)) reference = applyEvent(reference, seq, ts, event)
    if (page.nextAfter <= cursor) break
    cursor = page.nextAfter
  }
  const actual = normal(state), expected = normal(reference)
  const different = Object.keys(actual).filter((key) => digest(actual[key as keyof typeof actual]) !== digest(expected[key as keyof typeof expected]))
  console.log(JSON.stringify({ label: String.fromCharCode(65+index), buildMs, maxBatchMs, batches, readyMs, bytes, items: state.items.length, different, memory: process.memoryUsage() }))
  if (different.length) {
    const missing = expected.items.filter((item) => !actual.items.some((other) => other.position === item.position))
    const extra = actual.items.filter((item) => !expected.items.some((other) => other.position === item.position))
    const changed = actual.items.flatMap((item) => {
      const other = expected.items.find((entry) => entry.position === item.position)
      if (!other || digest(item) === digest(other)) return []
      return [{ position: item.position, kind: item.kind, fields: [...new Set([...Object.keys(item),...Object.keys(other)])].filter((key) => digest((item as any)[key] ?? null) !== digest((other as any)[key] ?? null)) }]
    })
    console.log(JSON.stringify({ missing: missing.map((v) => ({ position: v.position, kind: v.kind })), extra: extra.map((v) => ({ position: v.position, kind: v.kind })), changed: changed.slice(0,30), count: changed.length }))
    throw Error('Projection diverges from replay')
  }
}
sqlite.close()
