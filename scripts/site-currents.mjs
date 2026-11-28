#!/usr/bin/env node
/*
 * Fills the home page's "currents": the names of every feature of the catalog, drifting in three
 * rows above the capabilities. They are read from features.html, in each language, and written
 * between the <!-- currents --> markers of that language's index.html, so the home page cannot
 * name a feature the catalog no longer has. Each row holds its names twice: the loop is seamless.
 *
 *   node scripts/site-currents.mjs     # every language that has a features.html
 *
 * scripts/site-i18n.mjs calls it after building a language; run it by hand after changing the
 * English catalog. The UI check compares the currents with the catalog in both languages.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = new URL('../site/', import.meta.url)
const ROWS = 3

/** The catalog's titles in page order, as written there (entities and typography included). */
function titlesOf(features) {
  return [...features.matchAll(/<span class="feature-title">([\s\S]*?)<\/span><span class="feature-description">/g)]
    .map((match) => match[1].replace(/<span class="edition-label">[\s\S]*?<\/span>/g, '').trim())
}

/** Fills the currents of one language: '' for English, 'fr/' for French. Returns false when that language has no pages. */
export async function fillCurrents(folder = '') {
  let features
  let home
  try {
    features = await readFile(new URL(`${folder}features.html`, site), 'utf8')
    home = await readFile(new URL(`${folder}index.html`, site), 'utf8')
  } catch {
    return false
  }
  const titles = titlesOf(features)
  if (!titles.length) throw new Error(`${folder}features.html: no feature title found`)
  const start = '<!-- currents -->'
  const end = '<!-- /currents -->'
  const from = home.indexOf(start)
  const to = home.indexOf(end)
  if (from === -1 || to < from) throw new Error(`${folder}index.html: missing ${start} … ${end}${folder ? ' (build the translated pages first: node scripts/site-i18n.mjs)' : ''}`)
  const rows = Array.from({ length: ROWS }, (_, row) => titles.filter((_, index) => index % ROWS === row))
  const html = rows.map((row) => {
    const run = `<div class="current-run">${row.map((title) => `<span>${title}</span>`).join('')}</div>`
    return `        <div class="current">${run}${run}</div>`
  }).join('\n')
  const next = `${home.slice(0, from + start.length)}\n${html}\n        ${home.slice(to)}`
  if (next !== home) await writeFile(new URL(`${folder}index.html`, site), next)
  return true
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const folder of ['', 'fr/']) {
    if (await fillCurrents(folder)) console.log(`Currents filled in ${folder}index.html`)
  }
}
