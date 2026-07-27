import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runMigrations, type Db } from '@sillage/db'

/** Un dossier de migrations Drizzle valide contient toujours ce fichier. */
const JOURNAL = join('meta', '_journal.json')

/**
 * Les migrations vivent dans packages/db et sont copiées dans dist/ à la compilation.
 * On remonte l'arborescence depuis le module courant plutôt que de coder en dur une
 * profondeur relative, qui diffère entre dist/main.js et dist/cli/*.js.
 */
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

export function runPendingMigrations(db: Db, folder: string): void {
  runMigrations(db, folder)
}
