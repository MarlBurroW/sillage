import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkMigrations, runMigrations, type Db, type MigrationCheck } from '@sillage/db'

/** Valid Drizzle migration directories always contain this file. */
const JOURNAL = join('meta', '_journal.json')

/** Migrations live in packages/db and are copied to dist/ during builds. Walk upward from the current module instead of hardcoding relative depth, which differs between dist/main.js and dist/cli/*.js. */
export function migrationsFolder(): string {
  const fromEnv = process.env.SILLAGE_MIGRATIONS
  if (fromEnv) return fromEnv

  const suffixes = ['migrations', join('packages', 'db', 'migrations')]
  let dir = import.meta.dirname

  for (;;) {
    for (const suffix of suffixes) {
      const candidate = join(dir, suffix)
      if (existsSync(join(candidate, JOURNAL))) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  throw new Error(
    `Dossier de migrations introuvable depuis ${import.meta.dirname}. ` +
      'Lancer `pnpm db:generate` puis rebuilder, ou définir SILLAGE_MIGRATIONS.',
  )
}

/** Outcome of the startup check, shown by the health route so a rollback onto a newer schema is visible. */
export const migrationState: MigrationCheck = { newerThanRelease: false, skipped: 0 }

export function runPendingMigrations(db: Db, folder: string): void {
  Object.assign(migrationState, checkMigrations(db, folder))
  runMigrations(db, folder)
}
