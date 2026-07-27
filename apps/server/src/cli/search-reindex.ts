import { openDatabase } from '@sillage/db'
import { loadConfig } from '../config.js'
import { migrationsFolder, runPendingMigrations } from '../migrations.js'
import { rebuild } from '../search/search-index.js'

/**
 * Reconstruit l'index de recherche depuis le journal.
 *
 * L'index est dérivé (invariant I2), donc rien n'est perdu en le jetant. C'est ce
 * chemin qui rattrapera l'existant le jour où le contenu indexé changera, et le
 * recours si l'index et le journal divergent.
 */
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
