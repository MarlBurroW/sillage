import { defineConfig } from 'tsup'

// CommonJS lets Electron load the main process directly; a sandboxed preload,
// when the interface needs one, accepts only this format.
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
