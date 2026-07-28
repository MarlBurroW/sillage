import { execSync } from 'node:child_process'
import { defineConfig } from 'tsup'

/**
 * La CI de release fournit SILLAGE_VERSION depuis le tag git. En build local,
 * `git describe` donne un identifiant traçable ; hors dépôt (archive), `dev`.
 */
function resolveVersion(): string {
  if (process.env.SILLAGE_VERSION) return process.env.SILLAGE_VERSION.replace(/^v/, '')
  try {
    return execSync('git describe --tags --always --dirty', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  entry: [
    'src/main.ts',
    'src/cli/migrate.ts',
    'src/cli/user-create.ts',
    'src/cli/search-reindex.ts',
  ],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  define: {
    'process.env.SILLAGE_VERSION': JSON.stringify(resolveVersion()),
  },
  // Les modules natifs doivent rester externes, esbuild ne sait pas les embarquer.
  external: ['better-sqlite3', '@node-rs/argon2'],
  // Les paquets du monorepo n'exposent que du TypeScript : il faut les compiler ici.
  noExternal: ['@sillage/codex-bindings', '@sillage/db', '@sillage/protocol'],
})
