import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
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

/**
 * Holds an exclusive lock on a sidecar SQLite file, or returns null when another connection holds
 * it. SQLite's locks are released by the operating system when the process dies, on every
 * platform, which Node's own file APIs cannot offer. Used to keep a single server per database.
 */
export function tryExclusiveLock(file: string): { close(): void } | null {
  mkdirSync(dirname(file), { recursive: true })
  const handle = new Database(file, { timeout: 0 })
  try {
    handle.pragma('locking_mode = EXCLUSIVE')
    handle.exec('BEGIN EXCLUSIVE')
    return { close: () => handle.close() }
  } catch (err) {
    handle.close()
    if ((err as { code?: string }).code === 'SQLITE_BUSY') return null
    throw err
  }
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

/** The database was migrated by a release newer than this one, and strict mode asked to stop. */
export class SchemaNewerError extends Error {
  constructor(readonly appliedAt: number, readonly shippedAt: number) {
    super(
      `This database was migrated by a newer Sillage release (migration of ${new Date(appliedAt).toISOString()}, ` +
        `this release ships up to ${new Date(shippedAt).toISOString()}). Start the newer release, or restore a backup ` +
        'made before its upgrade.',
    )
    this.name = 'SchemaNewerError'
  }
}

export interface MigrationCheck {
  /** The database holds migrations this release does not ship: a rollback after an upgrade. */
  newerThanRelease: boolean
  /** Shipped migrations dated before the last applied one that are not recorded: they will never run. */
  skipped: number
}

/**
 * Compares the migrations recorded in the database with the ones shipped. Drizzle applies a
 * migration only when it is newer than the last one recorded, so two cases pass in silence:
 * an older release running on a schema migrated past it (a rollback), and a migration dated before
 * the last applied one, never run. Both are reported. A newer schema stops startup only with
 * SILLAGE_STRICT_SCHEMA=1: deployments roll back automatically after a failed start, and most
 * migrations only add columns or tables an older release ignores, so refusing would turn a
 * rollback into an outage. Call before `runMigrations`.
 */
export function checkMigrations(db: Db, migrationsFolder: string): MigrationCheck {
  const table = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`)
  if (table.length === 0) return { newerThanRelease: false, skipped: 0 }
  const applied = db.all<{ hash: string; created_at: number }>(sql`SELECT hash, created_at FROM __drizzle_migrations`)
  if (applied.length === 0) return { newerThanRelease: false, skipped: 0 }
  const shipped = readMigrationFiles({ migrationsFolder })
  const lastApplied = Math.max(...applied.map((row) => Number(row.created_at)))
  const lastShipped = Math.max(...shipped.map((migration) => migration.folderMillis))
  const newerThanRelease = lastApplied > lastShipped
  if (newerThanRelease) {
    if (process.env.SILLAGE_STRICT_SCHEMA === '1') throw new SchemaNewerError(lastApplied, lastShipped)
    console.warn(`sillage: ${new SchemaNewerError(lastApplied, lastShipped).message} Running anyway: writes to newer columns may fail.`)
  }
  // Hashes also differ when an applied migration's file was edited later: reported, not fatal.
  // The journal-date test in the server suite prevents the real case before release.
  const recorded = new Set(applied.map((row) => row.hash))
  const skipped = shipped.filter((migration) => migration.folderMillis <= lastApplied && !recorded.has(migration.hash))
  if (skipped.length > 0) {
    console.warn(
      `sillage: ${skipped.length} shipped migration(s) dated before the last applied one are not recorded and will not run ` +
        `(${skipped.map((migration) => new Date(migration.folderMillis).toISOString()).join(', ')}): ` +
        'a migration merged with an older date, or an applied migration edited afterwards.',
    )
  }
  return { newerThanRelease, skipped: skipped.length }
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
