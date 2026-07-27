import { defineConfig } from 'tsup'

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
  // Les modules natifs doivent rester externes, esbuild ne sait pas les embarquer.
  external: ['better-sqlite3', '@node-rs/argon2'],
  // Les paquets du monorepo n'exposent que du TypeScript : il faut les compiler ici.
  noExternal: ['@sillage/db', '@sillage/protocol'],
})
