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
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Transaction d'écriture, à préférer partout à `db.transaction`.
 *
 * `BEGIN IMMEDIATE` plutôt que le `BEGIN` différé de better-sqlite3 : une transaction
 * différée commence en lecture et ne demande le verrou d'écriture qu'à sa première
 * modification. Si un autre écrivain a committé entre-temps, SQLite refuse la montée
 * en écriture par un `SQLITE_BUSY_SNAPSHOT` immédiat, sans passer par le busy handler.
 * Le `busy_timeout` ne joue donc pas, et l'appelant reçoit « database is locked » alors
 * qu'il aurait suffi d'attendre. Prendre le verrou dès le départ rend l'attente
 * possible, au prix d'un verrou tenu un peu plus longtemps.
 *
 * Le cas s'est produit en vrai : le serveur MCP écrit une note de carte pendant que le
 * runner journalise le tour, l'écriture du journal a échoué et la session est morte
 * en plein travail.
 */
export function writeTransaction<T>(db: Db, body: (tx: Tx) => T): T {
  return db.transaction(body, { behavior: 'immediate' })
}

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
