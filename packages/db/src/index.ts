import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export * as schema from './schema.js'
export * from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>
export type SqliteHandle = InstanceType<typeof Database>

export function openDatabase(file: string): { db: Db; sqlite: SqliteHandle } {
  mkdirSync(dirname(file), { recursive: true })

  const sqlite = new Database(file)
  // WAL pour que les lectures du journal ne bloquent pas les écritures du daemon.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

export function runMigrations(db: Db, migrationsFolder: string): void {
  migrate(db, { migrationsFolder })
}
