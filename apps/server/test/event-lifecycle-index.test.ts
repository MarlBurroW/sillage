import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { conversations, openDatabase, runMigrations, schema, users, type Db } from '@sillage/db'
import { EventLog } from '../src/events/event-log.js'

/**
 * Restart recovery, shutdown and turn counts look events up by type. They must go through
 * `idx_events_lifecycle`: without it the boot-time lookup read the whole table, and each per-conversation
 * one a whole journal. SQLite only picks a partial index when the query repeats its condition
 * verbatim, which is easy to lose in a refactor: this test reads the actual plans.
 */
test('lifecycle lookups use the partial index instead of scanning journals', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-lifecycle-index-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { db: plain, sqlite } = openDatabase(join(dir, 'test.db'))
  t.after(() => sqlite.close())
  runMigrations(plain, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  plain.insert(users).values({ id: 'u', username: 'u', displayName: 'u', passwordHash: '', createdAt: 1 }).run()
  plain.insert(conversations).values({ id: 'c', userId: 'u', title: 'c', agent: 'claude', config: '{}', status: 'idle', createdAt: 1, updatedAt: 1 }).run()

  // The same connection, with every statement recorded.
  const queries: { sql: string; params: unknown[] }[] = []
  const db = drizzle(sqlite, { schema, logger: { logQuery: (query, params) => queries.push({ sql: query, params }) } }) as unknown as Db
  const log = new EventLog(db)
  const plans: Record<string, string> = {}
  const planOf = (name: string, run: () => unknown) => {
    queries.length = 0
    run()
    const reads = queries.filter((query) => /^select/i.test(query.sql.trim()) && /"?events"?/.test(query.sql))
    assert.ok(reads.length > 0, `${name} ran no events query`)
    plans[name] = reads
      .map((query) => sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...(query.params as never[])).map((row) => (row as { detail: string }).detail).join(' | '))
      .join(' || ')
  }

  planOf('openAsyncQuestionConversationIds', () => log.openAsyncQuestionConversationIds())
  planOf('openPrompts', () => log.openPrompts('c'))
  planOf('openBackgroundTasks', () => log.openBackgroundTasks('c'))
  planOf('openQueuedMessages', () => log.openQueuedMessages('c'))
  planOf('count turn.completed', () => log.count('c', 'turn.completed'))

  for (const [name, plan] of Object.entries(plans)) {
    assert.match(plan, /idx_events_lifecycle/, `${name}: ${plan}`)
    assert.doesNotMatch(plan, /SCAN events(?! USING)/, `${name} scans the table: ${plan}`)
  }
})
