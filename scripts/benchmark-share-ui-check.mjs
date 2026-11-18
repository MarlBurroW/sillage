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

// The benchmark pages on disposable Server and Desktop instances, with real run folders seeded in
// the database: the list, the outputs viewer and its layouts, then sharing end to end (verdicts,
// public page, archive, revocation). No model is called.
//
// BENCHMARK_SHOTS=<dir> keeps the screenshots; BENCHMARK_HOLD=1 leaves the Server instance up and
// prints its port, to look at the result by hand.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-bench-share-'))
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
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

// --- What the runs "produced" ------------------------------------------------------

/** A plain static landing page: what most benchmarks of this kind leave behind. */
function staticPage({ name, ink, paper, accent, font }) {
  return {
    'index.html': `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title><link rel="stylesheet" href="style.css"></head><body>
<header><strong>${name}</strong><nav><a href="#carte">Carte</a><a href="#lieu">Le lieu</a><a href="about.html">À propos</a></nav></header>
<main><h1>Le café qui prend son temps.</h1><p class="lead">Torréfaction maison, pâtisseries du matin, et une table près de la fenêtre.</p>
<button id="order">Réserver une table</button><p id="status" role="status"></p>
<section id="carte"><article><h2>Filtre</h2><p>Éthiopie, notes de bergamote.</p><span>4 €</span></article>
<article><h2>Flat white</h2><p>Double ristretto, lait entier.</p><span>4,50 €</span></article>
<article><h2>Cardamome</h2><p>Brioche roulée, encore tiède.</p><span>3,80 €</span></article></section></main>
<script src="app.js"></script></body></html>`,
    'about.html': `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><main><h1>À propos</h1><p class="lead">Ouvert depuis 2019, rue des Tanneurs.</p><a href="index.html">Retour</a></main>`,
    'style.css': `*{box-sizing:border-box}body{margin:0;font:17px/1.55 ${font};color:${ink};background:${paper}}
header{display:flex;justify-content:space-between;align-items:center;padding:20px 6vw}nav a{margin-left:20px;color:inherit;text-decoration:none;opacity:.7}
main{padding:6vh 6vw 10vh;max-width:1100px}h1{font-size:clamp(2.2rem,6vw,4.6rem);line-height:1.02;margin:0 0 .4em;letter-spacing:-.02em;max-width:14ch}
.lead{font-size:1.2rem;max-width:44ch;opacity:.8}button{margin-top:18px;font:inherit;font-weight:600;padding:14px 22px;border:0;border-radius:999px;background:${accent};color:${paper};cursor:pointer}
#status{min-height:1.5em;color:${accent};font-weight:600}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px;margin-top:6vh}
article{padding:20px;border:1px solid color-mix(in srgb,${ink} 18%,transparent);border-radius:14px}article h2{margin:0 0 6px;font-size:1.15rem}article p{margin:0 0 14px;opacity:.75}article span{font-weight:700;color:${accent}}`,
    'app.js': `let seats=6;document.getElementById('order').addEventListener('click',()=>{seats=Math.max(0,seats-1);document.getElementById('status').textContent=seats?'Table réservée. Il en reste '+seats+'.':'Complet pour ce soir.'})`,
    'README.md': `# ${name}\n\nPage statique : ouvrir \`index.html\`.\n`,
  }
}

/** A Vite project left unbuilt: a page that cannot leave the machine as is. */
const viteProject = {
  'index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  'src/main.tsx': "import { createRoot } from 'react-dom/client'\ncreateRoot(document.getElementById('root')!).render(<h1>Café</h1>)\n",
  'package.json': '{"scripts":{"dev":"vite"},"dependencies":{"react":"19","react-dom":"19"},"devDependencies":{"vite":"7","typescript":"5"}}',
  'vite.config.ts': 'export default {}\n',
}

/** A backend: nothing a browser can open on its own. */
const serverProject = {
  'server.js': "const express = require('express')\nconst app = express()\napp.get('/api/menu', (_, res) => res.json([]))\napp.listen(3000)\n",
  'package.json': '{"dependencies":{"express":"5"}}',
}

async function writeFolder(folder, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true })
    await writeFile(join(folder, path), content)
  }
}

const metrics = (durationMs, costUsd, model) => JSON.stringify({
  // The current fold version: an older snapshot would be refolded from a journal these seeds do not have.
  version: 3, durationMs, waitingMs: 0, firstTextMs: 4200, inputTokens: Math.round(durationMs / 2), outputTokens: Math.round(durationMs / 9),
  cacheReadTokens: 38462, cacheCreationTokens: 22512, costUsd, toolCalls: 7, toolErrors: 0, toolDurationMs: 900,
  assistantMessages: 4, outputChars: 2400, contextTokens: 35000, model, toolsByName: { Write: 4, Bash: 3 },
})

/** Benchmarks written straight into the instance's database, each run with its own folder. */
async function seed(dataDir) {
  const require = createRequire(join(serverDir, 'package.json'))
  const Database = require('better-sqlite3')
  // A clean tree has no compiled protocol yet, and this script runs outside tsx.
  const protocolDir = join(root, 'packages/protocol')
  const compile = run([join(root, 'node_modules/typescript/bin/tsc'), '-b'], protocolDir, process.env)
  const [compileCode] = await once(compile, 'exit')
  assert.equal(compileCode, 0, compile.diagnostics)
  const { deliverableKind } = await import(pathToFileURL(join(protocolDir, 'dist/index.js')).href)
  // What the runner records when a run ends: the list the outputs tab reads.
  const listed = (files) => JSON.stringify(Object.entries(files)
    .map(([path, content]) => ({ path, sizeBytes: Buffer.byteLength(content), kind: deliverableKind(path) }))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path)))
  const db = new Database(join(dataDir, 'sillage.db'))
  const user = db.prepare('select id from users order by created_at limit 1').get().id
  const now = Date.now()
  const variants = [
    { id: 'v0', label: 'Opus 5.5', config: { agent: 'claude', model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' } },
    { id: 'v1', label: 'Sonnet 5.5', config: { agent: 'claude', model: 'sonnet', effort: 'medium', permissionMode: 'bypassPermissions' } },
    { id: 'v2', label: 'GPT-5.4', config: { agent: 'codex', model: 'gpt-5.4', reasoningEffort: 'medium', askForApproval: 'never', sandbox: 'workspace-write' } },
    { id: 'v3', label: 'GPT-5.4 mini', config: { agent: 'codex', model: 'gpt-5.4-mini', reasoningEffort: 'low', askForApproval: 'never', sandbox: 'workspace-write' } },
  ]
  const productions = [
    [staticPage({ name: 'Café Lenteur', ink: '#1d2a24', paper: '#f3efe4', accent: '#2f6b4f', font: 'Georgia,serif' }),
      staticPage({ name: 'Café Lenteur', ink: '#1d2a24', paper: '#eef3ec', accent: '#8a4b2a', font: 'Georgia,serif' })],
    [staticPage({ name: 'Brûlerie Tanneurs', ink: '#f6f1ea', paper: '#17120f', accent: '#f0a13a', font: 'system-ui,sans-serif' }),
      staticPage({ name: 'Brûlerie Tanneurs', ink: '#f6f1ea', paper: '#101a22', accent: '#6fd0c0', font: 'system-ui,sans-serif' })],
    [viteProject, viteProject],
    [serverProject, serverProject],
  ]
  const insertBenchmark = db.prepare(`insert into benchmarks (id, user_id, name, prompt, variants, repetitions, concurrency, max_concurrent_runs, max_duration_minutes, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, 'parallel', 2, 20, ?, ?)`)
  const insertRun = db.prepare(`insert into benchmark_runs (id, benchmark_id, variant_id, repetition, conversation_id, status, started_at, finished_at, cli_version, metrics, response, preview_token, rating, error, files)
    values (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, ?)`)
  const insertWorkspace = db.prepare('insert into personal_workspaces (id, user_id, name, path, created_at) values (?, ?, ?, ?, ?)')
  const insertConversation = db.prepare(`insert into conversations (id, user_id, title, agent, status, config, workspace_id, created_at, updated_at, last_seq)
    values (?, ?, ?, ?, 'idle', '{}', ?, ?, ?, 0)`)

  insertBenchmark.run('cafe', user, 'Page d’accueil d’un café',
    'Crée la page d’accueil d’un café de quartier : un titre fort, la carte avec trois produits et leurs prix, et un bouton de réservation qui répond au clic.\n\nContraintes : pas de framework imposé, la page doit s’ouvrir sur téléphone, et le résultat doit tenir dans le dossier courant.\n\nSoigne la typographie et choisis une palette qui ne ressemble pas à un gabarit.\n\nTermine par trois lignes qui expliquent tes choix.',
    JSON.stringify(variants), 2, now - 3_600_000, now)
  const durations = [[92_000, 104_000], [58_000, 61_000], [141_000, 133_000], [47_000, 52_000]]
  for (const [index, variant] of variants.entries()) {
    for (const repetition of [1, 2]) {
      const id = `${variant.id}-${repetition}`
      const folder = join(dataDir, 'seed-runs', id)
      await writeFolder(folder, productions[index][repetition - 1])
      insertWorkspace.run(`w-${id}`, user, id, folder, now)
      insertConversation.run(`c-${id}`, user, `${variant.label} · ${repetition}`, variant.config.agent, `w-${id}`, now, now)
      const duration = durations[index][repetition - 1]
      insertRun.run(`run-${id}`, 'cafe', variant.id, repetition, `c-${id}`, 'succeeded', now - duration, now, metrics(duration, index < 2 ? duration / 300_000 : null, variant.config.model),
        `J’ai construit la page pour **${variant.label}**.\n\n- Une palette courte, pensée pour le lieu\n- La carte en trois articles\n- Un bouton de réservation qui décompte les tables`,
        `token-${id}`, repetition === 1 && index < 2 ? 5 - index : null, null, listed(productions[index][repetition - 1]))
    }
  }

  // Around it, enough variety for the list: one running, one that failed, one single-variant.
  insertBenchmark.run('running', user, 'Refactor d’un parseur', 'Réécris ce parseur récursif en itératif sans changer son comportement.', JSON.stringify(variants.slice(0, 3)), 1, now - 240_000, now)
  for (const [index, status] of ['succeeded', 'running', 'pending'].entries()) {
    insertRun.run(`running-${index}`, 'running', `v${index}`, 1, null, status, now - 200_000, status === 'succeeded' ? now : null, status === 'succeeded' ? metrics(71_000, 0.21, 'opus') : null, null, null, null, null, null)
  }
  insertBenchmark.run('failed', user, 'Jeu de la vie en WebGL', 'Un jeu de la vie plein écran, rendu en WebGL, 60 images par seconde.', JSON.stringify(variants.slice(1, 3)), 1, now - 86_400_000 * 2, now)
  insertRun.run('failed-0', 'failed', 'v1', 1, null, 'timed_out', now - 9e5, now, metrics(1_200_000, 1.4, 'sonnet'), null, null, null, 'Durée maximale atteinte', null)
  insertRun.run('failed-1', 'failed', 'v2', 1, null, 'failed', now - 9e5, now, null, null, null, null, 'Le CLI a quitté avec le code 1', null)
  db.close()
}

// --- Checks -------------------------------------------------------------------------

const PHONE = { width: 390, height: 844 }
const WIDE = { width: 1440, height: 900 }

async function checkPages(page, base, profile) {
  const shot = (name) => page.screenshot({ path: join(shots, `${profile}-${name}.png`) })

  // Index: the navigation column is the list, the space opens its most recent benchmark.
  await page.setViewportSize(WIDE)
  await page.goto(base + '/benchmarks')
  const links = page.locator('[data-sidebar-benchmarks] a')
  await page.waitForURL((url) => /^\/benchmarks\/[\w-]+$/.test(url.pathname), { timeout: 10_000 }).catch(async (error) => {
    await shot('failure')
    const api = await page.evaluate(() => fetch('/api/benchmarks').then(async (response) => `${response.status} ${(await response.text()).slice(0, 1500)}`))
    throw new Error(`${error.message}\n${page.url()}\n${api}`)
  })
  assert.equal(await links.count(), 3)
  // A folded column leaves a visible way back, first in the page's header.
  await page.getByRole('button', { name: 'Replier la liste' }).click()
  await page.locator('[data-nav-column]').waitFor({ state: 'detached' })
  await shot('wide-folded')
  assert.ok(await page.locator('[data-nav-unfold]').evaluate((button) => {
    const first = [...button.closest('header').querySelectorAll('button, a')].find((entry) => entry.getClientRects().length > 0)
    return first === button
  }), 'the way back leads the header')
  await page.locator('[data-nav-unfold]').click()
  await page.locator('[data-nav-column="benchmarks"]').waitFor()
  assert.equal(await page.locator('[data-nav-unfold]').count(), 0)
  assert.equal(await links.first().getAttribute('aria-current'), 'page', 'the index opens the first benchmark of the column')
  assert.equal(await page.getByRole('link', { name: 'Back to benchmarks' }).count() + await page.getByRole('link', { name: 'Retour aux benchmarks' }).count(), 0, 'no way back to a list that no longer exists')
  await shot('wide-index')
  // The column filters like the session list: by name, prompt or variant.
  await page.locator('[data-nav-column="benchmarks"]').getByRole('button', { name: 'Filtrer les benchmarks' }).click()
  await page.getByRole('searchbox', { name: 'Rechercher un benchmark' }).fill('webgl')
  assert.equal(await links.count(), 1)
  await page.getByRole('searchbox', { name: 'Rechercher un benchmark' }).fill('introuvable')
  await page.locator('[data-nav-column="benchmarks"]').getByText('Aucun benchmark ne correspond.').waitFor()
  await shot('wide-filter')
  await page.keyboard.press('Escape')
  assert.equal(await links.count(), 3)
  // Loaded at phone size: shrinking a wide window leaves the navigation drawer mid-way.
  await page.setViewportSize(PHONE)
  await page.goto(base + '/benchmarks')
  await page.locator('[data-benchmark-brief]').waitFor()
  await page.waitForTimeout(300)
  await shot('phone-index')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the opened benchmark does not overflow a phone')

  // Detail: the page uses the whole width.
  await page.setViewportSize(WIDE)
  await page.goto(base + '/benchmarks/cafe')
  const brief = page.locator('[data-benchmark-brief]')
  await brief.waitFor()
  const briefBox = await brief.boundingBox()
  const mainBox = await page.locator('main').last().boundingBox()
  assert.ok(briefBox.width > mainBox.width - 80, `the detail page is full width (${briefBox.width} of ${mainBox.width})`)
  await brief.getByRole('button', { expanded: false }).click()
  await brief.getByRole('button', { expanded: true }).click()
  await shot('wide-measures')

  // Outputs: one card per variant, opened on its main production.
  await page.getByRole('tab', { name: 'Productions', exact: true }).click()
  const outputs = page.locator('[data-benchmark-deliverables]')
  await outputs.waitFor()
  const cards = outputs.locator('[data-output-column]')
  assert.equal(await cards.count(), 4)
  // File lists arrive after the cards: wait for the picks rather than read them once.
  const picks = async (expected) => {
    await page.waitForFunction((wanted) => [...document.querySelectorAll('[data-benchmark-deliverables] [data-output-column]')]
      .map((card) => card.dataset.outputPick).join('|') === wanted, expected.join('|'), { timeout: 10_000 })
      .catch(async () => assert.deepEqual(await cards.evaluateAll((list) => list.map((card) => card.dataset.outputPick)), expected))
  }
  // The backend has no page: its card opens on its code rather than on its package.json.
  await picks(['index.html', 'index.html', 'index.html', 'server.js'])
  await outputs.frameLocator('iframe[title="index.html"]').first().getByRole('button', { name: 'Réserver une table' }).click()
  await shot('wide-outputs-grid')

  // A desktop width in a narrow card is scaled, not cropped.
  await outputs.getByRole('radio', { name: 'Ordinateur, 1280 px, réduit pour tenir' }).click()
  await page.waitForFunction(() => Number(document.querySelector('[data-output-scale]')?.dataset.outputScale) < 1)
  await outputs.getByRole('radio', { name: '2 par ligne' }).click()
  await outputs.getByRole('radio', { name: 'Cartes à la hauteur de la fenêtre' }).click()
  await shot('wide-outputs-scaled')

  // A card can show something else than the others.
  await cards.first().getByRole('button', { name: 'Choisir ce que montre cette carte' }).click()
  await page.getByRole('menuitem', { name: /about\.html/ }).click()
  assert.equal(await cards.first().getAttribute('data-output-pick'), 'about.html')
  await outputs.getByRole('radio', { name: 'Réponses' }).click()
  await picks(['response', 'response', 'response', 'response'])
  await outputs.getByRole('radio', { name: 'Productions' }).click()

  // One at a time, flipped with the arrows; the choice survives a reload.
  await outputs.getByRole('radio', { name: 'Une à la fois' }).click()
  assert.equal(await cards.count(), 1)
  const first = await cards.first().getAttribute('data-output-column')
  await outputs.getByRole('button', { name: 'Variante suivante' }).click()
  assert.notEqual(await cards.first().getAttribute('data-output-column'), first)
  await outputs.frameLocator('iframe').getByRole('button', { name: 'Réserver une table' }).waitFor()
  await page.waitForTimeout(300)
  await shot('wide-outputs-focus')
  await page.reload()
  await page.getByRole('tab', { name: 'Productions', exact: true }).click()
  assert.equal(await outputs.getAttribute('data-output-mode'), 'focus')
  await outputs.getByRole('radio', { name: 'Côte à côte' }).click()
  await outputs.getByRole('radio', { name: 'Largeur de la carte' }).click()
  await outputs.getByRole('radio', { name: 'Autant de cartes par ligne que la largeur le permet' }).click()
  await outputs.getByRole('radio', { name: 'Cartes moyennes' }).click()

  // Full screen, with the same switcher.
  await cards.first().getByRole('button', { name: 'Plein écran' }).click()
  const expanded = page.locator('[data-output-expanded]')
  await expanded.waitFor()
  await expanded.getByRole('button', { name: 'Variante suivante' }).click()
  await expanded.frameLocator('iframe').getByRole('button', { name: 'Réserver une table' }).waitFor()
  await page.waitForTimeout(300)
  await shot('wide-outputs-fullscreen')
  await page.keyboard.press('Escape')
  await expanded.waitFor({ state: 'detached' })

  // The second run of each variant is one choice away.
  await outputs.getByRole('radio', { name: 'Run 2', exact: true }).click()
  await outputs.locator('iframe[title="index.html"]').first().waitFor()

  // Blind review keeps names and measures out of the cards.
  await page.getByRole('button', { name: /valuer à l’aveugle/ }).click()
  const blind = page.locator('[data-benchmark-blind]')
  await blind.waitFor()
  const headings = await blind.locator('[data-output-column]').evaluateAll((list) => list.map((card) => card.textContent))
  assert.ok(!headings.some((text) => /Opus|Sonnet|GPT/.test(text)), 'blind cards hide the model')
  await shot('wide-outputs-blind')
  await page.getByRole('button', { name: 'Révéler les variantes', exact: true }).click()

  await page.setViewportSize(PHONE)
  await page.reload()
  await page.getByRole('tab', { name: 'Productions', exact: true }).click()
  await outputs.locator('iframe').first().waitFor()
  await page.waitForTimeout(300)
  await shot('phone-outputs')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the outputs do not overflow a phone')
  await page.setViewportSize(WIDE)
}

async function checkSharing(page, context, base, profile, canPublish) {
  const shot = (name) => page.screenshot({ path: join(shots, `${profile}-${name}.png`) })
  await page.goto(base + '/benchmarks/cafe')
  await page.locator('[data-benchmark-share-open]').click()
  const dialog = page.locator('[data-benchmark-share]')
  await dialog.locator('[data-share-runs]').waitFor()
  // Static pages go live; the unbuilt Vite project and the backend say why they do not.
  assert.deepEqual(
    await dialog.locator('[data-share-run]').evaluateAll((list) => list.map((item) => item.dataset.shareRun)),
    ['page', 'page', 'page', 'page', 'none', 'none', 'none', 'none'],
  )
  assert.match(await dialog.locator('[data-share-runs]').innerText(), /étape de build/)
  assert.match(await dialog.locator('[data-share-runs]').innerText(), /serveur qui tourne/)
  await dialog.getByLabel('Introduction').fill('Quatre modèles, le même brief. Les deux premiers ont livré une page ; regardez laquelle vous préférez.')
  await shot('wide-share')
  await page.setViewportSize(PHONE)
  await shot('phone-share')
  await page.setViewportSize(WIDE)

  // The archive holds the page whatever the edition.
  const href = await dialog.locator('[data-share-archive]').getAttribute('href')
  const archive = await page.evaluate(async (url) => {
    const response = await fetch(url)
    return { status: response.status, type: response.headers.get('content-type'), size: (await response.arrayBuffer()).byteLength }
  }, href)
  assert.equal(archive.status, 200)
  assert.match(archive.type, /zip/)
  assert.ok(archive.size > 2000)

  if (!canPublish) {
    // Desktop: no link to create, no tab listing links; the archive is the main action.
    assert.equal(await dialog.getByRole('button', { name: 'Créer un lien public' }).count(), 0)
    assert.equal(await dialog.getByRole('tab').count(), 0)
    await page.keyboard.press('Escape')
    return
  }

  await dialog.getByRole('button', { name: 'Créer un lien public' }).click()
  const published = dialog.locator('[data-share-published] a').first()
  await published.waitFor()
  const url = await published.getAttribute('href')
  assert.match(url, /\/s\/b\/[\w-]{32}\/$/)

  // The reader has no session: a fresh context opens the link.
  const reader = await browser.newContext({ viewport: WIDE, serviceWorkers: 'block' })
  const shared = await reader.newPage()
  const readerErrors = []
  shared.on('pageerror', (error) => { if (!/serviceWorker.*sandboxed/.test(error.message)) readerErrors.push(error.message) })
  const response = await shared.goto(url)
  assert.equal(response.status(), 200)
  assert.equal(await shared.locator('h1').innerText(), 'Page d’accueil d’un café')
  await shared.frameLocator('iframe').first().getByRole('button', { name: 'Réserver une table' }).click()
  await shared.screenshot({ path: join(shots, `${profile}-wide-public.png`) })
  await shared.screenshot({ path: join(shots, `${profile}-wide-public-full.png`), fullPage: true })
  await shared.emulateMedia({ colorScheme: 'dark' })
  await shared.screenshot({ path: join(shots, `${profile}-wide-public-dark.png`) })
  await shared.emulateMedia({ colorScheme: 'light' })
  await shared.setViewportSize(PHONE)
  await shared.screenshot({ path: join(shots, `${profile}-phone-public.png`) })
  await shared.screenshot({ path: join(shots, `${profile}-phone-public-full.png`), fullPage: true })
  assert.ok(await shared.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the public page does not overflow a phone')
  assert.deepEqual(readerErrors, [])

  // Revoking takes the page down.
  await dialog.getByRole('tab', { name: /Liens publics \(1\)/ }).click()
  await page.waitForTimeout(300)
  await shot('wide-share-links')
  if (!process.env.BENCHMARK_HOLD) {
    await dialog.locator('[data-share-links]').getByRole('button', { name: 'Révoquer le lien' }).click()
    await page.getByRole('dialog').last().getByRole('button', { name: 'Révoquer le lien' }).click()
    await dialog.getByRole('tab', { name: /Liens publics \(0\)/ }).waitFor()
    assert.equal((await shared.goto(url)).status(), 404)
  }
  await reader.close()
  await page.keyboard.press('Escape')
}

try {
  await mkdir(shots, { recursive: true })
  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...process.env, NODE_ENV: 'production' })
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)

  const port = process.env.BENCHMARK_PORT ? Number(process.env.BENCHMARK_PORT) : await freePort()
  const config = join(data, 'config.toml')
  // A public address is what makes links possible; the browser resolves this name to the loopback.
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
  await context.addInitScript(() => { if (window === window.top) localStorage.setItem('sillage.locale', 'fr') })
  const page = await context.newPage()
  const errors = []
  // Playwright's `serviceWorkers: 'block'` patches navigator.serviceWorker in every frame, which
  // throws inside the previews' opaque-origin sandbox. That is the harness, not the page.
  page.on('pageerror', (error) => { if (!/serviceWorker.*sandboxed/.test(error.message)) errors.push(error.message) })
  await page.goto(base + '/login')
  // Through the page, so the request resolves the public name like the browser does.
  const login = await page.evaluate(() => fetch('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'sillage-demo' }),
  }).then((response) => response.status))
  assert.equal(login, 200)

  await checkPages(page, base, 'server')
  await checkSharing(page, context, base, 'server', true)
  assert.deepEqual(errors, [])

  if (process.env.BENCHMARK_HOLD) {
    console.log(`benchmark-share-ui-check: holding on port ${port}; screenshots: ${shots}`)
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
    await desktopContext.addInitScript(() => { if (window === window.top) localStorage.setItem('sillage.locale', 'fr') })
    await desktopContext.addCookies([{ name: 'sillage_session', value: handshake.session, url: origin }])
    const settings = await desktopContext.request.patch(origin + '/api/me/settings', { data: { onboarding: { pending: false } } })
    assert.ok(settings.ok(), await settings.text())
    const desk = await desktopContext.newPage()
    const deskErrors = []
    desk.on('pageerror', (error) => { if (!/serviceWorker.*sandboxed/.test(error.message)) deskErrors.push(error.message) })
    await checkPages(desk, origin, 'desktop')
    await checkSharing(desk, desktopContext, origin, 'desktop', false)
    assert.deepEqual(deskErrors, [])
    console.log('benchmark-share-ui-check: ok; screenshots: ' + shots)
  }
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  if (!process.env.BENCHMARK_SHOTS && !process.env.BENCHMARK_HOLD) await rm(data, { recursive: true, force: true })
}
