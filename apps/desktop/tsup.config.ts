import { defineConfig } from 'tsup'

// The sandboxed preload requires CommonJS. Bundle updater dependencies because
// the packaged app does not include node_modules.
export default defineConfig({
  entry: ['src/main.ts', 'src/preload.ts'],
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  // The startup page shown while the server boots.
  publicDir: 'public',
  clean: true,
  external: ['electron'],
  outExtension: () => ({ js: '.cjs' }),
})
