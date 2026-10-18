import { defineConfig } from 'tsup'

// CommonJS : Electron charge ainsi le processus principal sans détour, et un preload en
// bac à sable, quand l'interface en aura besoin, n'accepte que ce format.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  external: ['electron'],
  outExtension: () => ({ js: '.cjs' }),
})
