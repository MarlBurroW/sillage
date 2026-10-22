import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { en } from '../../../apps/web/src/lib/i18n/prototypes/session-list/catalog-en.ts'
import { fr } from '../../../apps/web/src/lib/i18n/prototypes/session-list/catalog-fr.ts'

// Export only preview assets, so the preview server never exposes the repository.
const source = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(source, '../../..')
const destination = process.argv[2]
if (!destination) throw new Error('Usage: node build.mjs <output-directory>')
await mkdir(destination, { recursive: true })
for (const file of ['index.html', 'prototype.css', 'prototype.js', 'sidebar.html', 'full-sidebar.js', 'full-sidebar.css']) {
  await copyFile(resolve(source, file), resolve(destination, file))
}
await copyFile(resolve(root, 'apps/web/src/styles/tokens.css'), resolve(destination, 'tokens.css'))
await copyFile(resolve(root, 'apps/web/public/favicon.svg'), resolve(destination, 'favicon.svg'))
const icons = await readFile(resolve(root, 'apps/web/src/components/AgentIcon.tsx'), 'utf8')
const openAiPath = icons.split('function OpenAiMark')[1]?.match(/<path d="([^"]+)"/)[1]
const claudePath = icons.split('function ClaudeMark')[1]?.match(/<path d="([^"]+)"/)[1]
if (!claudePath) throw new Error('Claude mark missing in AgentIcon.tsx')
if (!openAiPath) throw new Error('OpenAI mark missing in AgentIcon.tsx')
await writeFile(resolve(destination, 'catalogs.js'), `export const catalogs = ${JSON.stringify({ en, fr })};\nexport const openAiPath = ${JSON.stringify(openAiPath)};\nexport const claudePath = ${JSON.stringify(claudePath)};\n`)
console.log(`Preview exported to ${destination}`)
