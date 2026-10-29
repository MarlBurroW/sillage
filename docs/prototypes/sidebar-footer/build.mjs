import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { en } from '../../../apps/web/src/lib/i18n/prototypes/sidebar-footer/catalog-en.ts'
import { fr } from '../../../apps/web/src/lib/i18n/prototypes/sidebar-footer/catalog-fr.ts'

const source = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(source, '../../..')
const destination = process.argv[2]
if (!destination) throw new Error('Usage: node build.mjs <output-directory>')
// Publish only preview assets, never the repository or its configuration.
await mkdir(destination, { recursive: true })
for (const file of ['index.html', 'prototype.css', 'prototype.js']) await copyFile(resolve(source, file), resolve(destination, file))
await copyFile(resolve(root, 'apps/web/src/styles/tokens.css'), resolve(destination, 'tokens.css'))
await copyFile(resolve(root, 'apps/web/public/favicon.svg'), resolve(destination, 'favicon.svg'))
const marks = await readFile(resolve(root, 'apps/web/src/components/AgentIcon.tsx'), 'utf8')
const paths = Object.fromEntries(['OpenAiMark', 'ClaudeMark'].map(name => {
  const path = marks.split(`function ${name}`)[1]?.match(/<path d="([^"]+)"/)[1]
  if (!path) throw new Error(`Missing ${name}`)
  return [name, path]
}))
await writeFile(resolve(destination, 'catalogs.js'), `export const catalogs = ${JSON.stringify({ en, fr })};\nexport const paths = ${JSON.stringify(paths)};\n`)
