import { openDatabase } from '@sillage/db'
import { loadConfig } from '../config.js'
import { migrationsFolder, runPendingMigrations } from '../migrations.js'
import { rebuild } from '../search/search-index.js'

/** Rebuilds search indexes from journals. Derived indexes (invariant I2) can be discarded without losing information. This path backfills changed indexing rules and repairs journal/index divergence. */
async function main(): Promise<void> {
  const config = loadConfig()
  const { db, sqlite } = openDatabase(config.paths.database)
  runPendingMigrations(db, migrationsFolder())

  try {
    const started = Date.now()
    const total = rebuild(db)
    console.log(`${total} messages indexés en ${Date.now() - started} ms.`)
  } finally {
    sqlite.close()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
