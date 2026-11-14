import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Export only preview assets, so the preview server never exposes the repository.
const source = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(source, '../../..')
const destination = process.argv[2]
if (!destination) throw new Error('Usage: node build.mjs <output-directory>')
await mkdir(destination, { recursive: true })

for (const file of ['index.html', 'prototype.css', 'prototype.js', 'data.js', 'icons.js']) {
  await copyFile(resolve(source, file), resolve(destination, file))
}
// The app's own tokens and sidebar rules, so rows look exactly like the real ones.
await copyFile(resolve(root, 'apps/web/src/styles/tokens.css'), resolve(destination, 'tokens.css'))
await copyFile(resolve(root, 'apps/web/src/styles/sidebar.css'), resolve(destination, 'sidebar.css'))
await copyFile(resolve(root, 'apps/web/public/favicon.svg'), resolve(destination, 'favicon.svg'))

// CLI marks and the logo come from the components, never from a copy that could drift.
const agentIcons = await readFile(resolve(root, 'apps/web/src/components/AgentIcon.tsx'), 'utf8')
const logo = await readFile(resolve(root, 'apps/web/src/components/Logo.tsx'), 'utf8')
const paths = (jsx) => [...jsx.matchAll(/<path [^>]*\/>/g)].map(([tag]) => tag.replace(/=\{([^}]+)\}/g, '="$1"')).join('')
const mark = (name, fill) => {
  const body = agentIcons.split(`function ${name}`)[1]?.split('\nfunction ')[0]
  const viewBox = body?.match(/viewBox="([^"]+)"/)?.[1]
  if (!body || !viewBox || !paths(body)) throw new Error(`${name} missing in AgentIcon.tsx`)
  return { viewBox, fill, body: paths(body) }
}
const marks = {
  claude: mark('ClaudeMark', '#D97757'),
  codex: mark('OpenAiMark', 'currentColor'),
  opencode: mark('OpencodeMark', 'currentColor'),
  grok: mark('GrokMark', 'currentColor'),
  logo: paths(logo),
}
if (!marks.logo) throw new Error('Logo paths missing in Logo.tsx')
await writeFile(resolve(destination, 'marks.js'), `export const marks = ${JSON.stringify(marks)}\n`)
console.log(`Preview exported to ${destination}`)
