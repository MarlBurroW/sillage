import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PRICE_SOURCES } from '../pricing/catalog.js'

/**
 * Rewrites the price lists shipped with the build, used until an instance reaches the network
 * (an offline desktop above all). Run before a release: `pnpm --filter @sillage/server prices:snapshot`.
 */
const snapshot: Record<string, unknown> = { fetchedAt: Date.now() }
for (const source of PRICE_SOURCES) {
  const response = await fetch(source.url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`)
  const table = source.reduce(await response.json())
  if (Object.keys(table).length < source.minimum) throw new Error(`${source.id}: only ${Object.keys(table).length} models`)
  snapshot[source.id] = table
  console.log(`${source.id}: ${Object.keys(table).length} models`)
}
writeFileSync(fileURLToPath(new URL('../pricing/bundled.json', import.meta.url)), `${JSON.stringify(snapshot)}\n`)
