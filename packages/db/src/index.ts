import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export * as schema from './schema.js'
export * from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>
export type SqliteHandle = InstanceType<typeof Database>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Copy another CLI's SQLite history consistently, including committed WAL pages. */
export async function backupSqlite(source: string, destination: string): Promise<void> {
  const sqlite = new Database(source, { readonly: true, fileMustExist: true })
  try { await sqlite.backup(destination) } finally { sqlite.close() }
}

/**
 * Write transaction; prefer this to `db.transaction` everywhere.
 *
 * Use `BEGIN IMMEDIATE` rather than better-sqlite3's deferred `BEGIN`: a deferred transaction
 * starts as a reader and requests the write lock only on its first mutation. If another writer
 * has committed meanwhile, SQLite rejects the upgrade immediately with `SQLITE_BUSY_SNAPSHOT`,
 * bypassing the busy handler. `busy_timeout` therefore has no effect, and the caller gets
 * “database is locked” when waiting would have sufficed. Taking the lock up front allows
 * waiting, at the cost of holding it slightly longer.
 *
 * This happened in production: the MCP server wrote a card note while the runner was journaling
 * a turn. The journal write failed and the session died mid-task.
 */
export function writeTransaction<T>(db: Db, body: (tx: Tx) => T): T {
  return db.transaction(body, { behavior: 'immediate' })
}

export function openDatabase(file: string): { db: Db; sqlite: SqliteHandle } {
  mkdirSync(dirname(file), { recursive: true })

  const sqlite = new Database(file)
  // WAL keeps journal reads from blocking daemon writes.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

export function runMigrations(db: Db, migrationsFolder: string): void {
  // SQLite ignores foreign_keys changes inside a transaction. Drizzle rebuilds tables
  // in its migration transaction; disabling beforehand prevents DROP from cascading into journals.
  const enabled = db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)[0]?.foreign_keys === 1
  if (enabled) db.run(sql`PRAGMA foreign_keys = OFF`)
  try {
    migrate(db, { migrationsFolder })
  } finally {
    if (enabled) db.run(sql`PRAGMA foreign_keys = ON`)
  }
}
