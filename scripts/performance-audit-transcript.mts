import assert from 'node:assert/strict'
import { appendFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, users } from '../packages/db/src/index.js'
import { EventLog } from '../apps/server/src/events/event-log.js'
import { readTranscript, transcriptPath } from '../apps/server/src/agents/claude/transcript.js'
import { importPreparedTranscript, prepareTranscript, savedTranscript } from '../apps/server/src/agents/claude/transcript-sync.js'

// Private disposable copy, no CLI, no production writes. Output is numeric only.
const [mode, source, anchor] = process.argv.slice(2)
const scratch = process.env.AUDIT_DIR
if (!scratch || !source || !anchor) throw new Error('AUDIT_DIR plus MODE SOURCE LAST_SHARED_UUID are required')
const dir = await mkdtemp(join(scratch, 'transcript-probe-'))
process.env.CLAUDE_CONFIG_DIR = dir
const file = transcriptPath(dir, 'audit')
await mkdir(dirname(file), { recursive: true })
await copyFile(source, file)
const { db, sqlite } = openDatabase(join(dir, 'test.db'))
try {
  runMigrations(db, fileURLToPath(new URL('../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'u', username: 'u', displayName: 'u', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', name: 'p', workspacePath: dir, ownerId: 'u', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'c', projectId: 'p', userId: 'u', title: 'c', agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const log = new EventLog(db)
  global.gc?.()
  const before = process.memoryUsage().heapUsed
  let started = performance.now()
  if (mode === 'reference') {
    const entries = await readTranscript(dir, 'audit')
    console.log(JSON.stringify({ mode, node: process.version, entries: entries.length, ms: performance.now() - started, heapBeforeMiB: before / 1048576, heapAfterMiB: process.memoryUsage().heapUsed / 1048576 }))
  } else {
    const prepared = await prepareTranscript(dir, 'audit', undefined, () => ({ uuids: new Set([anchor]), startedToolCallIds: new Set(), completedToolCallIds: new Set(), subAgentIds: new Set() }), true)
    assert.ok(prepared)
    const imported = await importPreparedTranscript({ prepared, db, log, id: 'c', cwd: dir, lastSeq: 0, release: async () => true })
    console.log(JSON.stringify({ mode: 'cold-recovery', node: process.version, ms: performance.now() - started, bytesRead: prepared.bytesRead, parsed: prepared.parsed, imported: imported.imported, heapBeforeMiB: before / 1048576, heapAfterMiB: process.memoryUsage().heapUsed / 1048576 }))
    started = performance.now()
    const saved = savedTranscript(db, 'c', imported.lastSeq)
    const unchanged = await prepareTranscript(dir, 'audit', saved)
    console.log(JSON.stringify({ mode: 'unchanged', ms: performance.now() - started, bytesRead: unchanged?.bytesRead, parsed: unchanged?.parsed }))
    assert.equal(unchanged?.bytesRead, 0)
    await appendFile(file, JSON.stringify({ type: 'user', uuid: 'audit-suffix', timestamp: new Date().toISOString(), message: { content: 'Synthetic benchmark suffix' } }) + '\n')
    started = performance.now()
    const suffix = await prepareTranscript(dir, 'audit', saved)
    assert.ok(suffix)
    const result = await importPreparedTranscript({ prepared: suffix, db, log, id: 'c', cwd: dir, lastSeq: imported.lastSeq, release: async () => true })
    console.log(JSON.stringify({ mode: 'append', ms: performance.now() - started, bytesRead: suffix.bytesRead, parsed: suffix.parsed, imported: result.imported, heapAfterMiB: process.memoryUsage().heapUsed / 1048576 }))
    assert.equal(suffix.parsed, 1)
  }
} finally {
  sqlite.close()
  await rm(dir, { recursive: true, force: true })
}
