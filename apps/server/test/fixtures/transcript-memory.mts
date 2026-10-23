import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { conversations, openDatabase, projects, runMigrations, users } from '@sillage/db'
import { EventLog } from '../../src/events/event-log.js'
import { transcriptPath } from '../../src/agents/claude/transcript.js'
import { importPreparedTranscript, prepareTranscript, savedTranscript } from '../../src/agents/claude/transcript-sync.js'

const dir = await mkdtemp(join(tmpdir(), 'sillage-transcript-memory-'))
process.env.CLAUDE_CONFIG_DIR = dir
const { db, sqlite } = openDatabase(join(dir, 'test.db'))
try {
  runMigrations(db, fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url)))
  db.insert(users).values({ id: 'u', username: 'u', displayName: 'u', passwordHash: '', createdAt: 1 }).run()
  db.insert(projects).values({ id: 'p', name: 'p', workspacePath: dir, ownerId: 'u', visibility: 'private', createdAt: 1 }).run()
  db.insert(conversations).values({ id: 'c', projectId: 'p', userId: 'u', title: 'c', agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()
  const log = new EventLog(db)
  const file = transcriptPath(dir, 'native')
  await mkdir(dirname(file), { recursive: true })
  const output = await open(file, 'w')
  const count = 16_000
  const make = (i: number) => ({ type: 'user', uuid: `u${i}`, timestamp: new Date(i * 1000).toISOString(), message: { content: 'x'.repeat(5000) } })
  for (let i = 0; i < count; i++) await output.write(JSON.stringify(make(i)) + '\n')
  await output.close()
  const recover = process.argv[2] === 'recover'
  if (recover) {
    // Heavy native journal payloads must not enter JS when extracting anchors.
    for (let i = 0; i < count; i++) log.append('c', { type: 'message.completed', messageId: `u${i}`, role: 'user', blocks: [{ type: 'text', text: 'x'.repeat(5000) }], parentToolCallId: null }, make(i))
  }
  const row = () => db.select().from(conversations).get()!
  const started = performance.now()
  const prepared = await prepareTranscript(dir, 'native', undefined, () => log.importAnchors('c'), recover)
  assert.ok(prepared)
  const result = await importPreparedTranscript({ prepared, db, log, id: 'c', cwd: dir, lastSeq: row().lastSeq, release: async () => true })
  const unchanged = await prepareTranscript(dir, 'native', savedTranscript(db, 'c', result.lastSeq))
  assert.equal(unchanged?.bytesRead, 0)
  assert.equal(unchanged?.parsed, 0)
  await appendFile(file, JSON.stringify(make(count)) + '\n')
  const suffix = await prepareTranscript(dir, 'native', savedTranscript(db, 'c', result.lastSeq))
  assert.equal(suffix?.parsed, 1)
  console.log(JSON.stringify({ mode: recover ? 'recover' : 'import', fileMiB: prepared.bytesRead / 1048576, imported: result.imported, unchangedBytes: unchanged.bytesRead, suffixParsed: suffix.parsed, ms: performance.now() - started, heapMiB: process.memoryUsage().heapUsed / 1048576 }))
} finally {
  sqlite.close()
  await rm(dir, { recursive: true, force: true })
}
