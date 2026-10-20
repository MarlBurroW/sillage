import { defineConfig } from 'tsup'

// CommonJS : Electron charge ainsi le processus principal sans détour, et le preload, en
// bac à sable, n'accepte que ce format. Les dépendances (electron-updater) sont incluses
// dans le paquet : l'app n'emporte pas de node_modules.
export default defineConfig({
  entry: ['src/main.ts', 'src/preload.ts'],
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  external: ['electron'],
  outExtension: () => ({ js: '.cjs' }),
})
