import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { en } from '../../../apps/web/src/lib/i18n/catalog-en.ts'
import { fr } from '../../../apps/web/src/lib/i18n/catalog-fr.ts'

const source = fileURLToPath(new URL('.', import.meta.url))
const output = resolve(process.argv[2] ?? '/var/tmp/sillage-typing-proposals')
await mkdir(output, { recursive: true })
for (const file of ['index.html', 'prototype.css', 'prototype.js']) {
  await copyFile(join(source, file), join(output, file))
}
await copyFile(new URL('../../../apps/web/src/styles/tokens.css', import.meta.url), join(output, 'tokens.css'))
await copyFile(new URL('../../brand/symbol.svg', import.meta.url), join(output, 'symbol.svg'))
// Catalogs remain single source; mockup bundles only its own text.
const pick = (catalog) => Object.fromEntries(Object.entries(catalog)
  .filter(([key]) => key.startsWith('prototype.typing.'))
  .map(([key, value]) => [key.slice('prototype.typing.'.length), value]))
await writeFile(join(output, 'translations.json'), JSON.stringify({ en: pick(en), fr: pick(fr) }))
console.log(output)
