import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import Fastify from 'fastify'
import { SchemaNewerError, checkMigrations, openDatabase, runMigrations } from '@sillage/db'
import { loadConfig } from '../src/config.js'
import { registerHealthRoutes } from '../src/http/routes/health.js'

/** Operability guards: migration order, a schema newer than the release, config keys that do nothing, health evidence. */

const migrations = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url))

function captureWarnings(t: TestContext): string[] {
  const seen: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(' ')) }
  t.after(() => { console.warn = original })
  return seen
}

test('migration journal dates strictly increase, or Drizzle skips the out-of-order one forever', () => {
  const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] }
  for (let i = 1; i < journal.entries.length; i++) {
    const [previous, current] = [journal.entries[i - 1]!, journal.entries[i]!]
    assert.ok(current.when > previous.when, `${current.tag} is dated before ${previous.tag}: regenerate it after rebasing`)
  }
})

test('a database migrated by a newer release is reported, and refused in strict mode', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-ops-checks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.db'))
  t.after(() => sqlite.close())
  runMigrations(db, migrations)
  assert.deepEqual(checkMigrations(db, migrations), { newerThanRelease: false, skipped: 0 })

  // A later release's migration, as after rolling back to this one.
  db.run(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('from-the-future', ${Date.now() + 86_400_000})`)
  const warnings = captureWarnings(t)
  assert.equal(checkMigrations(db, migrations).newerThanRelease, true)
  assert.match(warnings.join('\n'), /migrated by a newer Sillage release/)

  process.env.SILLAGE_STRICT_SCHEMA = '1'
  t.after(() => { delete process.env.SILLAGE_STRICT_SCHEMA })
  assert.throws(() => checkMigrations(db, migrations), SchemaNewerError)
})

test('a shipped migration that predates the last applied one is reported', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-ops-checks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db, sqlite } = openDatabase(join(dir, 'test.db'))
  t.after(() => sqlite.close())
  runMigrations(db, migrations)
  // As if one migration had been merged with an older date than the last applied one.
  db.run(sql`DELETE FROM __drizzle_migrations WHERE rowid = (SELECT min(rowid) + 1 FROM __drizzle_migrations)`)
  const warnings = captureWarnings(t)
  assert.equal(checkMigrations(db, migrations).skipped, 1)
  assert.match(warnings.join('\n'), /will not run/)
})

test('unknown and retired config keys are named instead of silently ignored', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-ops-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.toml')
  await writeFile(file, '[limits]\nmax_concurent_sessions = 3\nmax_attachment_bytes = 1000\n[retention]\narchived_events_days = 30\nauto_archive_days = 7\n[sever]\nport = 8000\n')
  const previous = process.env.SILLAGE_CONFIG
  process.env.SILLAGE_CONFIG = file
  t.after(() => { if (previous === undefined) delete process.env.SILLAGE_CONFIG; else process.env.SILLAGE_CONFIG = previous })
  const warnings = captureWarnings(t)

  const config = loadConfig()
  assert.equal(config.retention.autoArchiveDays, 7, 'known keys still apply')
  const text = warnings.join('\n')
  assert.match(text, /unknown setting limits\.maxConcurentSessions is ignored/)
  assert.match(text, /unknown setting sever is ignored/)
  assert.match(text, /retention\.archivedEventsDays has no effect and can be removed/)
  assert.match(text, /limits\.maxAttachmentBytes has no effect/)
  assert.doesNotMatch(text, /autoArchiveDays/)
})

test('health stays ok and reports the event loop and the schema state', async (t) => {
  const app = Fastify()
  registerHealthRoutes(app)
  t.after(() => app.close())
  const body = (await app.inject({ url: '/api/health' })).json()
  assert.equal(body.status, 'ok')
  assert.deepEqual(Object.keys(body.loop).sort(), ['maxMs', 'p99Ms'])
  assert.equal(body.schema, 'current')
})
