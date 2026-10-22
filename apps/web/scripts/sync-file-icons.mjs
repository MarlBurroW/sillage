import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Copy file icons into `public/`. Serve the 1250 SVGs statically rather than adding 240 KB
 * compressed to the panel bundle for icons shown only a few at a time. Request them on demand and
 * let the browser cache them; bundle only the lookup table. Service-worker precache excludes them
 * (`globPatterns` omits SVGs) to avoid downloading 1250 files for every update.
 */

const require = createRequire(import.meta.url)
const web = join(dirname(fileURLToPath(import.meta.url)), '..')

const source = join(dirname(require.resolve('material-icon-theme/package.json')), 'icons')
const target = join(web, 'public/file-icons')

// Start with a clean directory so removed library icons do not survive indefinitely in `public/`.
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })
