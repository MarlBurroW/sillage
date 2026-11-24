import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TOUR_START, TOUR_STEPS } from '../../web/src/components/tour/steps.js'

// The interface tour points at real elements through `tourAnchor('<step>')`. The interface
// moves often: this is where a step left without its element, or an anchor left without its
// step, is caught, instead of a bubble silently missing for every new account.
const webSrc = fileURLToPath(new URL('../../web/src/', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'tour' ? [] : sources(path)
    return entry.name.endsWith('.tsx') ? [path] : []
  })
}

test('chaque étape du tour de l’interface vise un élément qui existe', () => {
  const anchored = new Map<string, string[]>()
  for (const file of sources(webSrc)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/tourAnchor\('([a-z-]+)'\)/g)) {
      anchored.set(match[1]!, [...(anchored.get(match[1]!) ?? []), file.slice(webSrc.length)])
    }
  }
  const steps = TOUR_STEPS.map((step) => step.id)
  assert.equal(new Set(steps).size, steps.length, 'deux étapes ne visent pas le même élément')
  for (const id of steps) {
    assert.ok(anchored.has(id), `l’étape « ${id} » ne vise plus rien : remets tourAnchor('${id}') sur l’élément, ou retire l’étape de steps.ts`)
  }
  for (const [id, files] of anchored) {
    assert.ok(steps.includes(id as (typeof steps)[number]), `tourAnchor('${id}') dans ${files.join(', ')} ne correspond à aucune étape`)
  }
  assert.ok(steps.includes(TOUR_START), 'le tour démarre sur une de ses étapes')
})
