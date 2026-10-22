import { execSync } from 'node:child_process'
import { defineConfig } from 'tsup'

/**
 * Release CI supplies SILLAGE_VERSION from the git tag. Local builds use
 * `git describe` for a traceable identifier, or `dev` outside a repository (archive).
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
  // Native modules must remain external because esbuild cannot bundle them.
  external: ['better-sqlite3', '@node-rs/argon2'],
  // Monorepo packages expose only TypeScript, so they must be compiled here.
  noExternal: ['@sillage/codex-bindings', '@sillage/db', '@sillage/opencode-bindings', '@sillage/protocol'],
})
