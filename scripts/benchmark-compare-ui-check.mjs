import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

// The benchmark page's comparison and presenting on disposable Server and Desktop instances,
// with measured runs seeded in the database: picking variants (URL state, measures checkboxes),
// the duel and the matrix, saved comparisons, the chart's emphasis, the history across a series,
// the share window's new options with its live preview and slides, refreshing a published link.
// No model is called.
//
// BENCHMARK_SHOTS=<dir> keeps the screenshots; BENCHMARK_HOLD=1 leaves the Server instance up and
// prints its port; BENCHMARK_PORT pins it; BENCHMARK_PUBLIC_HOST names it for the browser.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-bench-compare-'))
const shots = process.env.BENCHMARK_SHOTS ?? join(data, 'shots')
const publicHost = process.env.BENCHMARK_PUBLIC_HOST ?? 'sillage.test'
const processes = []
let browser

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env, stdio = 'pipe') {
  const child = spawn(process.execPath, args, { cwd, env, stdio })
  processes.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  }
  return child
}

async function ready(url, child) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

/** A static page in a colour of its own, so side-by-side outputs read apart. */
function page(name, paper, ink, accent) {
  return {
    'index.html': `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title>
<style>body{margin:0;font:18px/1.5 system-ui,sans-serif;background:${paper};color:${ink}}main{padding:8vh 7vw}h1{font-size:clamp(2rem,6vw,4rem);margin:0 0 .3em;letter-spacing:-.02em}button{font:inherit;padding:12px 20px;border:0;border-radius:99px;background:${accent};color:${paper}}</style></head>
<body><main><h1>${name}</h1><p>Torréfaction maison et pâtisseries du matin.</p><button>Réserver une table</button></main></body></html>`,
  }
}

async function writeFolder(folder, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true })
    await writeFile(join(folder, path), content)
  }
}

const metrics = (durationMs, costUsd, model, toolCalls) => JSON.stringify({
  // The current fold version: an older snapshot would be refolded from a journal these seeds do not have.
  version: 3, durationMs, waitingMs: 0, firstTextMs: Math.round(durationMs / 20), inputTokens: durationMs * 3, outputTokens: Math.round(durationMs / 9),
  cacheReadTokens: durationMs * 2, cacheCreationTokens: 22512, costUsd, toolCalls, toolErrors: toolCalls > 20 ? 2 : 0, toolDurationMs: 900,
  assistantMessages: 4, outputChars: 2400, contextTokens: 35000, model, toolsByName: { Write: 4, Bash: toolCalls - 4 },
})

/**
 * Two Claude and two Codex variants left at their automatic labels, so the page names the
 * models; the last one was added after the others. A rerun adds a model of its own.
 */
async function seed(dataDir) {
  const require = createRequire(join(serverDir, 'package.json'))
  const Database = require('better-sqlite3')
  const protocolDir = join(root, 'packages/protocol')
  const compile = run([join(root, 'node_modules/typescript/bin/tsc'), '-b'], protocolDir, process.env)
  const [compileCode] = await once(compile, 'exit')
  assert.equal(compileCode, 0, compile.diagnostics)
  const { deliverableKind } = await import(pathToFileURL(join(protocolDir, 'dist/index.js')).href)
  const listed = (files) => JSON.stringify(Object.entries(files).map(([path, content]) => ({ path, sizeBytes: Buffer.byteLength(content), kind: deliverableKind(path) })))
  const db = new Database(join(dataDir, 'sillage.db'))
  const user = db.prepare('select id from users order by created_at limit 1').get().id
  const now = Date.now()
  const claude = (model) => ({ agent: 'claude', model, effort: 'medium', permissionMode: 'bypassPermissions' })
  const codex = (model) => ({ agent: 'codex', model, reasoningEffort: 'medium', askForApproval: 'never', sandbox: 'workspace-write' })
  const variants = [
    { id: 'v1', label: 'opus · medium', config: claude('opus') },
    { id: 'v2', label: 'sonnet · medium', config: claude('sonnet') },
    { id: 'v3', label: 'gpt-6.2-sol · medium', config: codex('gpt-6.2-sol') },
    { id: 'v4', label: 'gpt-6.1-terra · medium', config: codex('gpt-6.1-terra'), addedAt: now - 3_600_000 },
  ]
  const announced = { v1: 'claude-opus-5-5', v2: 'claude-sonnet-5-5', v3: 'gpt-6.2-sol', v4: 'gpt-6.1-terra' }
  const pages = {
    v1: page('Café Lenteur', '#f3efe4', '#1d2a24', '#2f6b4f'),
    v2: page('Brûlerie Tanneurs', '#17120f', '#f6f1ea', '#f0a13a'),
    v3: page('Le Comptoir', '#eef3fb', '#14213d', '#2856c7'),
    v4: page('Petit Noir', '#fff4f0', '#3b1f1a', '#c2410c'),
  }
  // [duration, cost, tool calls, rating] per repetition; v3's second run failed.
  const runs = {
    v1: [[412_000, 1.84, 31, 5], [398_000, 1.71, 28, null]],
    v2: [[226_000, 0.62, 22, 4], [241_000, 0.66, 24, null]],
    v3: [[188_000, 0.41, 18, 3], [95_000, 0.12, 6, null, 'failed']],
    v4: [[121_000, 0.19, 14, 4], [133_000, 0.21, 15, null]],
  }
  const insertBenchmark = db.prepare(`insert into benchmarks (id, user_id, name, prompt, variants, repetitions, concurrency, max_concurrent_runs, max_duration_minutes, series_id, comparisons, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, 'parallel', 2, 20, ?, ?, ?, ?)`)
  const insertRun = db.prepare(`insert into benchmark_runs (id, benchmark_id, variant_id, repetition, conversation_id, status, started_at, finished_at, cli_version, metrics, response, preview_token, rating, error, files)
    values (?, ?, ?, ?, ?, ?, ?, ?, '2.1.325', ?, ?, ?, ?, ?, ?)`)
  const insertWorkspace = db.prepare('insert into personal_workspaces (id, user_id, name, path, created_at) values (?, ?, ?, ?, ?)')
  const insertConversation = db.prepare(`insert into conversations (id, user_id, title, agent, status, config, workspace_id, created_at, updated_at, last_seq)
    values (?, ?, ?, ?, 'idle', '{}', ?, ?, ?, 0)`)
  // Two comparisons over the same variants (a pruned trio leaves such pairs): each must stay reachable.
  const comparisons = [{ id: 'c-mid', title: 'Milieu de gamme', variantIds: ['v2', 'v4'] }, { id: 'c-dup', title: 'Doublon', variantIds: ['v4', 'v2'] }]
  insertBenchmark.run('cafe', user, 'Page d’accueil d’un café', 'Crée la page d’accueil d’un café de quartier : un titre fort, la carte et un bouton de réservation.',
    JSON.stringify(variants), 2, null, JSON.stringify(comparisons), now - 7_200_000, now - 1_800_000)
  for (const variant of variants) {
    for (const [index, [duration, cost, tools, rating, status = 'succeeded']] of runs[variant.id].entries()) {
      const id = `${variant.id}-${index + 1}`
      const folder = join(dataDir, 'seed-runs', id)
      await writeFolder(folder, pages[variant.id])
      insertWorkspace.run(`w-${id}`, user, id, folder, now)
      insertConversation.run(`c-${id}`, user, `${variant.label} · ${index + 1}`, variant.config.agent, `w-${id}`, now, now)
      const started = variant.addedAt ? now - 3_000_000 : now - 7_000_000
      insertRun.run(`run-${id}`, 'cafe', variant.id, index + 1, `c-${id}`, status, started, started + duration, metrics(duration, cost, announced[variant.id], tools),
        `Page construite pour **${variant.label}**.`, `token-${id}`, rating, status === 'failed' ? 'Le CLI a quitté avec le code 1' : null, listed(pages[variant.id]))
    }
  }
  // A rerun of the same benchmark, which gained a model the original never had.
  const rerun = [variants[0], variants[1], { id: 'v9', label: 'haiku · medium', config: claude('haiku') }]
  insertBenchmark.run('cafe-2', user, 'Page d’accueil d’un café', 'Crée la page d’accueil d’un café de quartier : un titre fort, la carte et un bouton de réservation.',
    JSON.stringify(rerun), 1, 'cafe', null, now - 600_000, now - 300_000)
  for (const [index, variant] of rerun.entries()) {
    insertRun.run(`rerun-${variant.id}`, 'cafe-2', variant.id, 1, null, 'succeeded', now - 600_000, now - 600_000 + 100_000 * (index + 1),
      metrics(100_000 * (index + 1), 0.2 * (index + 1), variant.id === 'v9' ? 'claude-haiku-5-5' : announced[variant.id], 10), null, null, null, null, null)
  }
  // One run each, and the third one crashed fast: its 20 s must never rank as the fastest.
  insertBenchmark.run('crash', user, 'Parseur qui plante', 'Écris un parseur de formules.', JSON.stringify(variants.slice(0, 3)), 1, null, null, now - 1_200_000, now - 1_100_000)
  for (const [index, [duration, status]] of [[200_000, 'succeeded'], [150_000, 'succeeded'], [20_000, 'failed']].entries()) {
    const variant = variants[index]
    insertRun.run(`crash-${variant.id}`, 'crash', variant.id, 1, null, status, now - 1_200_000, now - 1_200_000 + duration,
      metrics(duration, 0.1 * (index + 1), announced[variant.id], 9), null, null, null, status === 'failed' ? 'Le CLI a quitté avec le code 1' : null, null)
  }
  // Two variants only: nothing to pick, but its saved comparison must still be reachable.
  insertBenchmark.run('duo', user, 'Duel de parseurs', 'Écris un parseur de formules.', JSON.stringify(variants.slice(0, 2)), 1, null,
    JSON.stringify([{ id: 'c-duo', title: 'Duel maison', variantIds: ['v1', 'v2'] }]), now - 900_000, now - 800_000)
  for (const [index, variant] of variants.slice(0, 2).entries()) {
    insertRun.run(`duo-${variant.id}`, 'duo', variant.id, 1, null, 'succeeded', now - 900_000, now - 900_000 + 100_000 * (index + 1),
      metrics(100_000 * (index + 1), 0.3 * (index + 1), announced[variant.id], 12), null, null, null, null, null)
  }
  db.close()
}

const PHONE = { width: 390, height: 844 }
const WIDE = { width: 1440, height: 900 }

async function popupOf(page, click) {
  const [popup] = await Promise.all([page.waitForEvent('popup'), click()])
  await popup.waitForLoadState('domcontentloaded')
  return popup
}

async function checkCompare(page, base, profile) {
  const shot = (name) => page.screenshot({ path: join(shots, `${profile}-${name}.png`) })
  await page.setViewportSize(WIDE)
  await page.goto(base + '/benchmarks/cafe')
  await page.locator('[data-benchmark-results]').waitFor()

  // Short public names, the exact model beside them, the late variant dated.
  const headers = await page.locator('[data-benchmark-results] th[scope=rowgroup]').allInnerTexts()
  assert.equal(headers.length, 4)
  assert.ok(headers[3].includes('ajoutée le'), `the added variant says so: ${headers[3]}`)
  await shot('wide-measures')

  // Picking from the measures: an inline line, then the duel.
  await page.locator('[data-compare-check="v1"]').check()
  await page.locator('[data-compare-check="v3"]').check()
  const line = page.locator('[data-compare-selection]')
  await line.waitFor()
  await shot('wide-measures-selected')
  await line.getByRole('button', { name: 'Comparer', exact: true }).click()
  await page.waitForURL((url) => url.searchParams.get('tab') === 'compare' && url.searchParams.get('vs') === 'v1,v3')
  const duel = page.locator('[data-benchmark-compare="duel"]')
  await duel.waitFor()
  assert.ok(await duel.locator('[data-compare-verdict]').count() >= 2, 'verdicts for time and cost at least')
  assert.ok(await duel.locator('[data-duel-row]').count() >= 5)
  // The fastest of the two that succeeded wins time: v3's failed run does not count.
  assert.equal(await duel.locator('[data-compare-verdict="durationMs"]').getAttribute('data-winner'), 'v3')
  await duel.locator('[data-compare-duel]').scrollIntoViewIfNeeded()
  await shot('wide-compare-duel')

  // Swapping sides changes the address, so the comparison can be sent as it is.
  await duel.getByRole('button', { name: 'Inverser les côtés' }).click()
  await page.waitForURL((url) => url.searchParams.get('vs') === 'v3,v1')

  // A third variant turns the duel into a matrix against the baseline.
  await page.locator('[data-compare-chip="v2"]').click()
  const matrix = page.locator('[data-benchmark-compare="matrix"]')
  await matrix.waitFor()
  assert.equal(await matrix.locator('[data-compare-head]').count(), 3)
  assert.ok(await matrix.locator('[data-compare-winner]').count() >= 1)
  await shot('wide-compare-matrix')

  // A saved comparison applies in one click, and can be renamed.
  await page.locator('[data-compare-saved-chip="c-mid"]').click()
  await page.waitForURL((url) => url.searchParams.get('vs') === 'v2,v4')
  await duel.waitFor()
  await page.getByRole('button', { name: 'Renommer ou supprimer cette comparaison' }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('Titre (facultatif)').fill('Sonnet contre Terra')
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  await page.locator('[data-compare-saved-chip="c-mid"]', { hasText: 'Sonnet contre Terra' }).waitFor()

  // Two comparisons over the same variants: the one clicked is the one renamed or deleted.
  await page.locator('[data-compare-saved-chip="c-dup"]').click()
  await page.waitForURL((url) => url.searchParams.get('vs') === 'v4,v2')
  assert.equal(await page.locator('[data-compare-saved-chip="c-dup"]').getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('[data-compare-saved-chip="c-mid"]').getAttribute('aria-pressed'), 'false')
  await page.getByRole('button', { name: 'Renommer ou supprimer cette comparaison' }).click()
  assert.equal(await page.getByRole('dialog').getByLabel('Titre (facultatif)').inputValue(), 'Doublon')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.locator('[data-compare-saved-chip="c-mid"]').click()
  await page.waitForURL((url) => url.searchParams.get('vs') === 'v2,v4')
  assert.equal(await page.locator('[data-compare-saved-chip="c-mid"]').getAttribute('aria-pressed'), 'true')

  // The current selection becomes a new saved comparison.
  await page.locator('[data-compare-chip="v2"]').click()
  await page.locator('[data-compare-chip="v4"]').click()
  await page.locator('[data-compare-chip="v1"]').click()
  await page.locator('[data-compare-chip="v3"]').click()
  await page.waitForURL((url) => url.searchParams.get('vs') === 'v1,v3')
  await page.locator('[data-compare-save]').click()
  await page.getByRole('dialog').getByLabel('Titre (facultatif)').fill('Haut de gamme')
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await page.locator('[data-compare-saved-chip]', { hasText: 'Haut de gamme' }).waitFor()
  await page.reload()
  await page.locator('[data-compare-saved-chip]', { hasText: 'Haut de gamme' }).waitFor()
  await shot('wide-compare-saved')

  // The chart keeps the compared variants in front.
  await page.getByRole('tab', { name: 'Graphique' }).click()
  await page.locator('[data-benchmark-chart]').waitFor()
  assert.equal(await page.locator('[data-chart-muted]').count(), 2)
  await page.waitForTimeout(300)
  await shot('wide-chart-emphasis')

  // History reads the union of the series' lineups: the rerun's own model gets its row.
  await page.getByRole('tab', { name: /Historique/ }).click()
  await page.locator('[data-benchmark-series]').waitFor()
  assert.equal(await page.locator('[data-series-cell="cafe:v9"]').innerText(), '—')
  assert.notEqual(await page.locator('[data-series-cell="cafe-2:v9"]').innerText(), '—')
  assert.equal(await page.locator('[data-series-cell="cafe-2:v3"]').innerText(), '—')
  await page.waitForTimeout(300)
  await shot('wide-history')

  // Tapping the open benchmark in the column (how the phone drawer closes) keeps what is open:
  // its bare address gets the tab and the selection back. Back still follows the address.
  await page.goto(base + '/benchmarks/cafe?tab=compare&vs=v2,v4')
  await page.locator('[data-benchmark-compare="duel"]').waitFor()
  await page.locator('[data-sidebar-benchmarks] a[href="/benchmarks/cafe"]').click()
  await page.waitForURL((url) => url.searchParams.get('tab') === 'compare' && url.searchParams.get('vs') === 'v2,v4')
  await page.locator('[data-benchmark-compare="duel"]').waitFor()
  assert.equal(await page.getByRole('tab', { name: /^Comparer/ }).getAttribute('aria-selected'), 'true', 'the column tap keeps the open tab')
  await page.goto(base + '/benchmarks/cafe?tab=chart')
  await page.locator('[data-benchmark-chart]').waitFor()
  await page.locator('[data-sidebar-benchmarks] a[href="/benchmarks/cafe"]').click()
  await page.waitForURL((url) => url.searchParams.get('tab') === 'chart')
  await page.getByRole('tab', { name: /^Comparer/ }).click()
  await page.waitForURL((url) => url.searchParams.get('tab') === 'compare')
  await page.goBack()
  await page.waitForURL((url) => url.searchParams.get('tab') === 'chart')
  await page.locator('[data-benchmark-chart]').waitFor()
  assert.equal(await page.getByRole('tab', { name: 'Graphique' }).getAttribute('aria-selected'), 'true', 'Back follows the address')

  // A variant whose only run crashed fast sorts after those that succeeded, and its chart bar is
  // hatched and labelled rather than drawn as the shortest one.
  await page.goto(base + '/benchmarks/crash')
  await page.locator('[data-benchmark-results]').waitFor()
  await page.locator('[data-benchmark-results] thead button', { hasText: 'Durée' }).click()
  const groups = await page.locator('[data-benchmark-group]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-benchmark-group')))
  assert.deepEqual(groups, ['v2', 'v1', 'v3'], 'a failed run never sorts as the fastest')
  await page.getByRole('tab', { name: 'Graphique' }).click()
  await page.locator('[data-benchmark-chart]').waitFor()
  assert.equal(await page.locator('[data-chart-failed-only]').count(), 1)
  await page.getByText('runs en échec seulement').first().waitFor()
  await page.waitForTimeout(200)
  await shot('wide-chart-failed-only')

  // Two variants: no picking, but the saved comparison is applied, renamed and kept, and swapping
  // sides leaves no count on the tab nor a selection line over a table without checkboxes.
  await page.goto(base + '/benchmarks/duo?tab=compare')
  await page.locator('[data-benchmark-compare="duel"]').waitFor()
  assert.equal(await page.locator('[data-compare-picker]').count(), 0, 'nothing to pick between two variants')
  await page.locator('[data-compare-saved-chip="c-duo"]').waitFor()
  assert.equal(await page.locator('[data-compare-saved-chip="c-duo"]').getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: 'Inverser les côtés' }).click()
  await page.waitForURL((url) => url.searchParams.get('vs') === 'v2,v1')
  assert.equal(await page.getByRole('tab', { name: 'Comparer', exact: true }).count(), 1, 'no count on the tab of a duel')
  await page.getByRole('tab', { name: 'Mesures' }).click()
  await page.locator('[data-benchmark-results]').waitFor()
  assert.equal(await page.locator('[data-compare-selection]').count(), 0, 'no selection line without checkboxes')
  await page.waitForTimeout(200)
  await shot('wide-duo-measures')
  // A leftover single id in the address of a duel mutes no bar: both variants are compared.
  await page.goto(base + '/benchmarks/duo?tab=chart&vs=v2')
  await page.locator('[data-benchmark-chart]').waitFor()
  assert.equal(await page.locator('[data-chart-muted]').count(), 0, 'no bar muted on a duel')

  // A phone picks from a menu, and nothing overflows.
  await page.setViewportSize(PHONE)
  await page.goto(base + '/benchmarks/cafe?tab=compare&vs=v2,v4')
  await page.locator('[data-benchmark-compare="duel"]').waitFor()
  await page.waitForTimeout(300)
  await shot('phone-compare')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the comparison does not overflow a phone')
  await page.getByRole('button', { name: /Variantes à comparer \(2\)/ }).click()
  await page.getByRole('menuitemcheckbox').first().waitFor()
  await shot('phone-compare-menu')
  await page.keyboard.press('Escape')
  await page.setViewportSize(WIDE)
}

/**
 * A blind review keeps its letters when the lineup changes: the stored order stands, a variant it
 * does not know takes the next letter, and a review stored the old way (a seed) is frozen.
 */
async function checkBlind(page, base, profile) {
  const key = 'sillage.benchmark.blind.cafe'
  await page.goto(base + '/benchmarks/cafe')
  await page.locator('[data-benchmark-results]').waitFor()
  await page.evaluate((name) => localStorage.setItem(name, JSON.stringify({ order: ['v4', 'v2', 'v1'], revealed: false })), key)
  await page.reload()
  const blind = page.locator('[data-benchmark-blind]')
  await blind.waitFor()
  await blind.locator('[data-output-column="Variante A"]').frameLocator('iframe').getByRole('heading', { name: 'Petit Noir' }).waitFor()
  await blind.locator('[data-output-column="Variante D"]').frameLocator('iframe').getByRole('heading', { name: 'Le Comptoir' }).waitFor()
  // The newcomer's letter is written down at once: reordering the lineup later cannot move it.
  await page.waitForFunction((name) => JSON.stringify(JSON.parse(localStorage.getItem(name) ?? '{}').order) === JSON.stringify(['v4', 'v2', 'v1', 'v3']), key)
  await page.screenshot({ path: join(shots, `${profile}-wide-blind.png`) })
  await page.evaluate((name) => localStorage.setItem(name, JSON.stringify({ seed: 12345, revealed: false })), key)
  await page.reload()
  await blind.waitFor()
  await page.waitForFunction((name) => Array.isArray(JSON.parse(localStorage.getItem(name) ?? '{}').order), key)
  await page.evaluate((name) => localStorage.removeItem(name), key)
}

async function checkSharing(page, base, profile, canPublish) {
  const shot = (name) => page.screenshot({ path: join(shots, `${profile}-${name}.png`) })
  await page.goto(base + '/benchmarks/cafe')
  await page.locator('[data-benchmark-share-open]').click()
  const dialog = page.locator('[data-benchmark-share]')
  await dialog.locator('[data-share-runs]').waitFor()
  assert.equal(await dialog.locator('[data-share-comparisons] [role=switch]').count(), 3, 'every saved comparison can be featured')
  await dialog.getByRole('switch', { name: 'Masquer les modèles au départ' }).click()
  await dialog.locator('[data-share-reveal]').getByRole('radio', { name: 'À la fin' }).click()
  await shot('wide-share-options')

  // Preview and slides render live, and remember the options for the page's Present button.
  const preview = await popupOf(page, () => dialog.locator('[data-share-preview]').click())
  assert.match(new URL(preview.url()).pathname, /^\/api\/benchmarks\/cafe\/live\/page$/)
  const previewStatus = await page.evaluate((url) => fetch(url).then((response) => response.status), preview.url())
  assert.equal(previewStatus, 200, 'the live page answers')
  await preview.screenshot({ path: join(shots, `${profile}-share-preview.png`) })
  await preview.close()
  const slides = await popupOf(page, () => dialog.locator('[data-share-present]').click())
  assert.match(new URL(slides.url()).pathname, /^\/api\/benchmarks\/cafe\/live\/slides$/)
  assert.equal(JSON.parse(new URL(slides.url()).searchParams.get('options')).revealAt, 'end')
  await slides.close()

  if (canPublish) {
    await dialog.getByRole('button', { name: 'Créer un lien public' }).click()
    await dialog.locator('[data-share-published] a').first().waitFor()
    await dialog.getByRole('tab', { name: /Liens publics \(1\)/ }).click()
    const refresh = dialog.locator('[data-share-refresh]')
    await refresh.waitFor()
    assert.equal(await refresh.isDisabled(), false, 'a new link keeps its options and can be updated')
    await refresh.click()
    await dialog.locator('[data-share-link]', { hasText: 'mis à jour le' }).waitFor()
    await shot('wide-share-links')
  } else {
    assert.equal(await dialog.getByRole('button', { name: 'Créer un lien public' }).count(), 0)
  }
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })

  // The header's Present button opens the slides with the options last prepared.
  const present = await popupOf(page, () => page.locator('[data-benchmark-present]').click())
  const options = JSON.parse(new URL(present.url()).searchParams.get('options'))
  assert.equal(options.blind, true)
  assert.equal(options.revealAt, 'end')
  await present.close()
}

try {
  await mkdir(shots, { recursive: true })
  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...process.env, NODE_ENV: 'production' })
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)

  const port = process.env.BENCHMARK_PORT ? Number(process.env.BENCHMARK_PORT) : await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, `[server]\npublicUrl = "http://${publicHost}:${port}"\n[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n[agents.antigravity]\nenabled = false\n`)
  const env = {
    ...process.env, NODE_ENV: 'development',
    SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: webDist,
  }
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  await ready(`http://127.0.0.1:${port}/api/health`, server)
  const demo = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [demoCode] = await once(demo, 'exit')
  assert.equal(demoCode, 0, demo.diagnostics)
  await seed(join(data, 'data'))

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true, args: [`--host-resolver-rules=MAP ${publicHost} 127.0.0.1`] })
  const base = `http://${publicHost}:${port}`
  const context = await browser.newContext({ viewport: WIDE, locale: 'fr-FR', serviceWorkers: 'block' })
  // Not in sandboxed previews, nor in the about:blank a popup starts with: storage is denied there.
  await context.addInitScript(() => { if (window === window.top && location.protocol.startsWith('http')) localStorage.setItem('sillage.locale', 'fr') })
  const pageErrors = []
  context.on('page', (opened) => opened.on('pageerror', (error) => { if (!/serviceWorker.*sandboxed/.test(error.message)) pageErrors.push(`${opened.url()}: ${error.message}\n${error.stack ?? ''}`) }))
  const page = await context.newPage()
  await page.goto(base + '/login')
  const login = await page.evaluate(() => fetch('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'sillage-demo' }),
  }).then((response) => response.status))
  assert.equal(login, 200)

  await checkCompare(page, base, 'server')
  await checkBlind(page, base, 'server')
  await checkSharing(page, base, 'server', true)
  assert.deepEqual(pageErrors, [])

  if (process.env.BENCHMARK_HOLD) {
    console.log(`benchmark-compare-ui-check: holding on port ${port}; screenshots: ${shots}`)
    await browser.close()
    browser = null
    await once(server, 'exit')
  } else {
    const desktop = run(['--import', 'tsx', 'src/main.ts'], serverDir, {
      ...env, SILLAGE_CONFIG: join(data, 'none.toml'), SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3',
      SILLAGE_PORT: String(await freePort()), SILLAGE_DATA_DIR: join(data, 'desktop-data'),
    }, ['pipe', 'pipe', 'pipe', 'pipe'])
    const handshake = await new Promise((resolve, reject) => {
      let buffer = ''
      desktop.stdio[3].setEncoding('utf8')
      desktop.stdio[3].on('data', (chunk) => {
        buffer += chunk
        const end = buffer.indexOf('\n')
        if (end !== -1) resolve(JSON.parse(buffer.slice(0, end)))
      })
      desktop.once('exit', () => reject(new Error(desktop.diagnostics)))
    })
    const origin = 'http://127.0.0.1:' + handshake.port
    await seed(join(data, 'desktop-data'))
    const desktopContext = await browser.newContext({ viewport: WIDE, locale: 'fr-FR', serviceWorkers: 'block' })
    await desktopContext.addInitScript(() => { if (window === window.top && location.protocol.startsWith('http')) localStorage.setItem('sillage.locale', 'fr') })
    await desktopContext.addCookies([{ name: 'sillage_session', value: handshake.session, url: origin }])
    const settings = await desktopContext.request.patch(origin + '/api/me/settings', { data: { onboarding: { pending: false } } })
    assert.ok(settings.ok(), await settings.text())
    const deskErrors = []
    desktopContext.on('page', (opened) => opened.on('pageerror', (error) => { if (!/serviceWorker.*sandboxed/.test(error.message)) deskErrors.push(`${opened.url()}: ${error.message}\n${error.stack ?? ''}`) }))
    const desk = await desktopContext.newPage()
    await checkCompare(desk, origin, 'desktop')
    await checkBlind(desk, origin, 'desktop')
    await checkSharing(desk, origin, 'desktop', false)
    assert.deepEqual(deskErrors, [])
    console.log('benchmark-compare-ui-check: ok; screenshots: ' + shots)
  }
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  if (!process.env.BENCHMARK_SHOTS && !process.env.BENCHMARK_HOLD) await rm(data, { recursive: true, force: true })
}
