import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { EventLog } from '../apps/server/src/events/event-log.js'
import { coalesceDeltas } from '../apps/server/src/events/coalesce.js'
import { applyEvent, emptyChatState } from '../apps/web/src/lib/chat-fold.js'
import { readTranscript } from '../apps/server/src/agents/claude/transcript.js'
import * as schema from '../packages/db/src/schema.js'

// Read-only probes: no openDatabase(), migrations, running CLI or user state writes.
const require = createRequire(new URL('../apps/server/package.json', import.meta.url))
const Database = require('better-sqlite3')
const { drizzle } = require('drizzle-orm/better-sqlite3')
const [mode, database, id, ...args] = process.argv.slice(2)
const sqlite = new Database(database, { readonly: true })
const log = new EventLog(drizzle(sqlite, { schema }))
const memory = () => ({ ...process.memoryUsage(), maxRss: process.resourceUsage().maxRSS * 1024 })
global.gc?.()
console.log(JSON.stringify({ stage: 'before', mode, node: process.version, memory: memory() }))
const started = performance.now()
if (mode === 'anchors') {
  const anchors = log.importAnchors(id)
  console.log(JSON.stringify({ stage: 'after', mode, ms: performance.now() - started, counts: Object.fromEntries(Object.entries(anchors).map(([key, value]) => [key, value.size])), memory: memory() }))
} else if (mode === 'raw-tool' || mode === 'raw-tool-reference') {
  const tool = sqlite.prepare("select json_extract(payload,'$.toolCallId') as id from events where conversation_id=? and type='tool.started' order by seq limit 1").get(id)
  // Frozen pre-fix algorithm for repeatable before/after memory measurements.
  function originalLookup() {
    const rows = sqlite.prepare("select type,payload,raw from events where conversation_id=? and type in ('tool.started','tool.completed') order by seq").all(id)
    const found = { started: null, completed: null }
    for (const row of rows) {
      if (JSON.parse(row.payload).toolCallId !== tool.id || !row.raw) continue
      if (row.type === 'tool.started') found.started = JSON.parse(row.raw)
      else found.completed = JSON.parse(row.raw)
    }
    return found
  }
  const result = mode === 'raw-tool-reference' ? originalLookup() : log.rawOfTool(id, tool.id)
  console.log(JSON.stringify({ stage: 'after', mode, ms: performance.now() - started, found: Boolean(result.started || result.completed), memory: memory() }))
  if (mode === 'raw-tool-reference') {
    assert.deepEqual(log.rawOfTool(id, tool.id), result)
    console.log(JSON.stringify({ stage: 'verification', nativePayloadsMatch: true }))
  }
} else if (mode === 'transcript') {
  const entries = await readTranscript(args[0], id)
  console.log(JSON.stringify({ stage: 'after', mode, ms: performance.now() - started, entries: entries.length, memory: memory() }))
} else if (mode === 'replay' || mode === 'replay-bodies') {
  let cursor = 0, state = emptyChatState()
  const totals = { readMs: 0, coalesceMs: 0, stringifyMs: 0, foldMs: 0, bytes: 0, images: 0, imageBytes: 0, maxPageMs: 0, maxPageBytes: 0, pages: 0, events: 0 }
  const bytesByType: Record<string, number> = {}
  for (;;) {
    let t = performance.now()
    const page = log.readForReplay(id, cursor, { rows: 5000, bytes: 16 * 1024 * 1024, bodies: mode === 'replay-bodies' })
    totals.readMs += performance.now() - t
    if (page.nextAfter <= cursor) break
    t = performance.now()
    const entries = coalesceDeltas(page.entries)
    totals.coalesceMs += performance.now() - t
    t = performance.now()
    const body = JSON.stringify({ entries: entries.map(({ seq, ts, event }) => ({ seq, ts, event })), nextAfter: page.nextAfter })
    totals.stringifyMs += performance.now() - t
    const bytes = Buffer.byteLength(body)
    totals.bytes += bytes
    totals.maxPageBytes = Math.max(totals.maxPageBytes, bytes)
    for (const { event } of entries) {
      bytesByType[event.type] = (bytesByType[event.type] ?? 0) + Buffer.byteLength(JSON.stringify(event))
      if (event.type === 'message.completed') {
        for (const block of event.blocks) if (block.type === 'image') {
          totals.images++
          totals.imageBytes += Buffer.byteLength(block.url)
        }
      }
    }
    t = performance.now()
    for (const entry of entries) if (entry.seq > state.lastSeq) state = applyEvent(state, entry.seq, entry.ts, entry.event)
    const foldMs = performance.now() - t
    totals.foldMs += foldMs
    totals.maxPageMs = Math.max(totals.maxPageMs, foldMs)
    totals.pages++
    totals.events += entries.length
    cursor = page.nextAfter
  }
  console.log(JSON.stringify({ stage: 'after', mode, ms: performance.now() - started, totals, bytesByType, items: state.items.length, memory: memory() }))
  global.gc?.()
  console.log(JSON.stringify({ stage: 'after-gc', memory: memory(), items: state.items.length }))
} else throw new Error(`Unknown mode: ${mode}`)
sqlite.close()
