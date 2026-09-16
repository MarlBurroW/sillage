import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { checkEditor } from './checks/editor.mjs'
import { checkIde } from './checks/ide.mjs'
import { checkDownloads } from './checks/downloads.mjs'
import { checkFavorites } from './checks/favorites.mjs'

// Vrais composants et vraie API, dans une base temporaire. Aucun CLI n'est activé.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-ui-check-'))
const processes = []
let browser

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'pipe' })
  processes.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  }
  return child
}

async function ready(url, child) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript((origin) => {
    // La visionneuse PDF du navigateur n'expose pas le stockage de l'application.
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const projects = await (await context.request.get(`${base}/api/projects`)).json()
  const project = projects.find((entry) => entry.name === 'Nimbus')
  const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
  const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
  const cards = await (await context.request.get(`${base}/api/projects/${project.id}/cards`)).json()
  const card = cards.find((entry) => entry.number === 2)
  const board = `${base}/p/${project.id}/board`
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const description = page.getByRole('textbox', { name: 'Description', exact: true })
  const save = page.getByRole('button', { name: 'Enregistrer', exact: true })
  const close = page.getByRole('button', { name: 'Fermer', exact: true })
  const openCard = async (number) => {
    await page.goto(`${board}?carte=${number}`)
    await page.getByLabel(`Carte #${number}`, { exact: true }).waitFor()
    if (await description.count() === 0) await page.getByRole('button', { name: 'Modifier la carte', exact: true }).click()
    await description.waitFor()
  }

  await openCard(2)
  const draft = `${card.description}\nBrouillon de vérification`
  await description.fill(draft)
  await close.click()
  await page.getByRole('button', { name: /#2 Offline caching for forecasts/ }).click()
  assert.equal(await description.inputValue(), draft, 'Closing a card must preserve its draft')
  await page.reload()
  await description.waitFor()
  assert.equal(await description.inputValue(), draft, 'Reloading must preserve the draft')
  await openCard(1)
  assert.notEqual(await description.inputValue(), draft, 'Drafts belong to their card')
  await openCard(2)
  assert.equal(await description.inputValue(), draft)

  const endpoint = `**/api/cards/${card.id}`
  await page.route(endpoint, (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, json: { error: { code: 'ui_test_failure', message: 'Simulated write failure' } } })
    : route.continue())
  await save.click()
  await page.getByRole('alert').filter({ hasText: 'Enregistrement impossible' }).waitFor()
  assert.equal(await description.inputValue(), draft, 'A failed save must preserve the draft')
  await page.unroute(endpoint)

  let release
  let intercepted
  const pending = new Promise((resolve) => { intercepted = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'PATCH') {
      intercepted()
      await gate
    }
    await route.continue()
  })
  await save.click()
  await pending
  const newerDraft = `${draft}\nAjout pendant la sauvegarde`
  await description.fill(newerDraft)
  await close.click()
  await page.getByRole('button', { name: /#2 Offline caching for forecasts/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Enregistrement…', exact: true }).isDisabled(), true)
  const response = page.waitForResponse((entry) => entry.url().endsWith(`/api/cards/${card.id}`) && entry.request().method() === 'PATCH')
  release()
  await response
  await save.waitFor()
  assert.equal(await description.inputValue(), newerDraft, 'An earlier save must not erase newer input')
  await page.unroute(endpoint)
  await save.click()
  await page.getByText('Brouillon conservé dans cet onglet.', { exact: false }).waitFor({ state: 'hidden' })
  await page.reload()
  await page.getByRole('button', { name: 'Modifier la carte', exact: true }).click()
  await description.waitFor()
  assert.equal(await description.inputValue(), newerDraft, 'Successful changes must be persisted by the API')
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('sillage.cardDraft:')).length), 0)
  const latestSession = card.conversations.filter((session) => !session.archivedAt).sort((a, b) => b.createdAt - a.createdAt)[0]
  assert.ok(latestSession)
  await page.getByRole('button', { name: 'Reprendre la session', exact: true }).click()
  await page.waitForURL(`**/c/${latestSession.id}`)
  await openCard(2)
  await page.getByRole('button', { name: 'Nouvelle session', exact: true }).click()
  await page.waitForURL(`**/c/new?card=${card.id}`)
  console.log('OK : brouillons par carte, échec et sauvegarde concurrente, reprise et nouvelle session.')


  await page.goto(`${board}?carte=2`)
  await page.getByRole('button', { name: 'Modifier la carte', exact: true }).waitFor()
  assert.equal(await description.count(), 0, 'A saved card opens for reading')
  const noteField = page.getByRole('textbox', { name: 'Ajouter une note', exact: true })
  const addNote = page.getByRole('button', { name: 'Ajouter une note', exact: true })
  const noteA = 'Une note à conserver après fermeture.'
  const noteB = 'Une deuxième note écrite pendant la publication.'
  await noteField.fill(noteA)
  await close.click()
  await page.getByRole('button', { name: /#2 Offline caching for forecasts/ }).click()
  assert.equal(await noteField.inputValue(), noteA)
  await page.reload()
  await noteField.waitFor()
  assert.equal(await noteField.inputValue(), noteA)
  const noteEndpoint = `**/api/cards/${card.id}/notes`
  await page.route(noteEndpoint, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { error: { code: 'ui_test', message: 'Simulated note failure' } } })
    : route.continue())
  await addNote.click()
  await page.getByRole('alert').filter({ hasText: 'La note n’a pas été enregistrée.' }).waitFor()
  assert.equal(await noteField.inputValue(), noteA)
  await page.unroute(noteEndpoint)
  let releaseNote, noteSent
  const noteGate = new Promise((resolve) => { releaseNote = resolve })
  const noteIntercepted = new Promise((resolve) => { noteSent = resolve })
  await page.route(noteEndpoint, async (route) => {
    if (route.request().method() === 'POST') { noteSent(); await noteGate }
    await route.continue()
  })
  await addNote.click()
  await noteIntercepted
  await noteField.fill(noteB)
  await close.click()
  await page.getByRole('button', { name: /#2 Offline caching for forecasts/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Enregistrement…', exact: true }).isDisabled(), true)
  releaseNote()
  await page.getByText(noteA, { exact: true }).waitFor()
  assert.equal(await noteField.inputValue(), noteB, 'Publishing an earlier note must preserve newer input')
  await page.unroute(noteEndpoint)
  await addNote.click()
  await page.getByText(noteB, { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Ajouter une note"]')?.value === '')
  assert.equal(await page.getByText(noteA, { exact: true }).isVisible(), false, 'Older notes are collapsed')
  await page.getByText(/^Notes précédentes \(/).click()
  await page.getByText(noteA, { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('sillage.cardNoteDraft:')).length), 0)
  await page.reload()
  await page.getByText(noteB, { exact: true }).waitFor()
  console.log('OK : lecture de carte, brouillons de notes, échec de publication et dernière note en premier.')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(board)
  const column = page.getByRole('region', { name: 'À faire', exact: true })
  await column.waitFor()
  assert.ok((await column.boundingBox()).width >= 360, 'The mobile board must use its available width')
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus() })
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Ouvrir la navigation')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Fermer la navigation')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => document.activeElement.closest('[role="dialog"]')?.getAttribute('aria-label')), 'Navigation')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Ouvrir la navigation')
  console.log('OK : largeur du board, navigation invisible inerte, focus contenu et restitué.')

  const firstCard = cards.find((entry) => entry.number === 1)
  const opener = page.locator(`[data-card-open="${firstCard.id}"]`)
  await opener.click()
  const mobileCard = page.getByRole('dialog', { name: 'Carte #1', exact: true })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Fermer')
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i === 0 ? 'Shift+Tab' : 'Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]')?.getAttribute('aria-label')), 'Carte #1')
  }
  await page.keyboard.press('Escape')
  await page.waitForFunction((id) => document.activeElement?.getAttribute('data-card-open') === id, firstCard.id)
  await opener.click()
  await mobileCard.getByRole('button', { name: /^Changer la colonne/ }).click()
  await page.getByRole('menu').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'hidden' })
  assert.equal(await mobileCard.isVisible(), true, 'Escape in the column menu must leave the card open')
  await mobileCard.getByRole('button', { name: /^Changer la colonne/ }).click()
  await page.getByRole('menuitem', { name: 'À vérifier', exact: true }).click()
  await mobileCard.getByRole('button', { name: 'Changer la colonne : À vérifier', exact: true }).waitFor()
  await mobileCard.getByRole('button', { name: 'Fermer', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Ouvrir la navigation')
  await page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
  const workspace = page.getByRole('dialog', { name: 'Panneau du workspace', exact: true })
  await workspace.waitFor()
  const showTree = workspace.getByRole('button', { name: "Afficher l'arborescence", exact: true })
  if (await showTree.count()) await showTree.click()
  const searchFile = workspace.getByRole('searchbox', { name: 'Chercher un fichier', exact: true })
  await searchFile.fill('README')
  await page.keyboard.press('Escape')
  assert.equal(await workspace.isVisible(), true, 'Escape in file search must not close the workspace')
  assert.equal(await searchFile.inputValue(), '')
  await workspace.getByText('README.md', { exact: true }).first().click()
  await workspace.getByRole('button', { name: 'Source', exact: true }).click()
  const code = page.locator('[data-panel="workspace"] .cm-content').first()
  await code.waitFor()
  await code.evaluate((node) => { window.uiEditorNode = node })
  await code.click()
  await page.keyboard.press('Escape')
  assert.equal(await workspace.isVisible(), true, 'Escape remains available inside the editor')
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.equal(await code.evaluate((node) => node === window.uiEditorNode), true)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await code.evaluate((node) => node === window.uiEditorNode), true, 'Resizing must retain the editor DOM')
  await workspace.getByRole('button', { name: 'Fermer le panneau', exact: true }).focus()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Ouvrir le panneau')
  console.log('OK : focus des panneaux, menu superposé, raccourcis de l’éditeur et redimensionnement sans remontage.')

  await checkEditor({ page, context, base, project })
  await checkIde({ page, context, base, project })
  await checkDownloads({ page, context, base, project, hero, data })
  await checkFavorites({ page, context, base, project, hero })


  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/p/${project.id}/c/${hero.id}`)
  await page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
  const panel = page.locator('[data-panel="workspace"]')
  await panel.getByRole('button', { name: 'Agrandir le panneau', exact: true }).waitFor()
  const composer = page.locator('form').filter({ has: page.getByPlaceholder('Écris ton message...') })
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-panel="workspace"]')).translate === '0px')
  const docked = await panel.boundingBox()
  const composerBounds = await composer.boundingBox()
  assert.ok(composerBounds.width >= 400 && docked.width >= 320)
  assert.ok(composerBounds.x + composerBounds.width <= docked.x + 1, 'The panel must not cover the conversation')
  await panel.getByRole('button', { name: 'Git', exact: true }).click()
  await panel.getByRole('button', { name: 'Agrandir le panneau', exact: true }).click()
  assert.ok((await panel.boundingBox()).width > docked.width)
  assert.equal(await panel.getByRole('button', { name: 'Git', exact: true }).getAttribute('aria-pressed'), 'true')
  await panel.getByRole('button', { name: 'Afficher à côté de la conversation', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => Math.round(document.querySelector('[data-panel="workspace"]').getBoundingClientRect().width) === innerWidth)
  await panel.getByRole('button', { name: 'Fermer le panneau', exact: true }).click()
  await panel.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: /Réglages de la conversation,/ }).click()
  await page.getByRole('dialog', { name: 'Réglages de la conversation', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: 'Joindre un fichier', exact: true }).evaluate((node) => node.getBoundingClientRect().height >= 44), true)
  console.log('OK : conversation et panneau côte à côte, agrandissement, repli mobile et réglages accessibles.')

  for (const width of [320, 390, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`)
  }

  // Les filtres partagent le vrai socket ; seules les transitions de test sont injectées.
  let activitySocket
  await page.routeWebSocket('**/api/ws', (socket) => {
    activitySocket = socket
    socket.connectToServer()
  })
  await page.goto(board)
  const activity = page.getByRole('group', { name: 'Suivi des conversations', exact: true })
  await activity.waitFor()
  const all = await (await context.request.get(`${base}/api/conversations`)).json()
  const candidate = all.find((entry) => !entry.archivedAt && entry.status === 'idle')
  assert.ok(candidate)
  const awaiting = activity.getByRole('button', { name: /^À débloquer/ })
  const before = Number((await awaiting.innerText()).match(/\d+$/)[0])
  await awaiting.click()
  const result = page.locator('#sidebar-activity-results')
  const candidateLink = result.locator(`a[href="/p/${candidate.projectId}/c/${candidate.id}"]`)
  assert.equal(await candidateLink.count(), 0)
  const pushStatus = (status, background = 0) => activitySocket.send(JSON.stringify({
    t: 'status', conversationId: candidate.id, status, background, loops: 0,
    warm: true, appliedConfig: null, lastNotableSeq: candidate.lastNotableSeq, metrics: candidate.metrics,
  }))
  pushStatus('awaiting_input')
  await candidateLink.waitFor()
  assert.equal(Number((await awaiting.innerText()).match(/\d+$/)[0]), before + 1)
  pushStatus('running')
  await candidateLink.waitFor({ state: 'hidden' })
  await activity.getByRole('button', { name: /^En cours/ }).click()
  await candidateLink.waitFor()
  pushStatus('idle')
  await candidateLink.waitFor({ state: 'hidden' })
  pushStatus('idle', 1)
  await candidateLink.waitFor()
  pushStatus('idle')
  await candidateLink.waitFor({ state: 'hidden' })

  const unreadEntry = all.find((entry) => !entry.archivedAt && entry.lastNotableSeq > entry.lastReadSeq)
  assert.ok(unreadEntry)
  await activity.getByRole('button', { name: /^Non lues/ }).click()
  const unreadLink = result.locator(`a[href="/p/${unreadEntry.projectId}/c/${unreadEntry.id}"]`)
  await unreadLink.click()
  await page.waitForURL(`**/c/${unreadEntry.id}`)
  await unreadLink.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Tous les projets', exact: true }).click()
  console.log('OK : filtres en direct, travaux de fond, lecture et retour aux projets.')

  // La reprise ne traverse ni un compte ni un projet devenu inaccessible.
  const heroPath = `/p/${project.id}/c/${hero.id}`
  await page.goto(base + heroPath)
  await page.locator('textarea').waitFor()
  await page.goto(base + '/settings/compte')
  await page.goto(base + '/')
  await page.waitForURL(base + heroPath)
  await openCard(2)
  await page.goto(base + '/settings/compte')
  await page.goto(base + '/')
  await page.waitForURL(`${board}?carte=2`)
  const currentUser = await (await context.request.get(base + '/api/auth/me')).json()
  await page.goto(base + '/settings/compte')
  await page.evaluate(({ id }) => localStorage.setItem(`sillage.lastContext:${id}`, '/p/deleted/c/inaccessible'), currentUser)
  await page.goto(base + '/')
  await page.waitForURL(/\/p\/(?!deleted)[^/]+\/c\//)
  assert.notEqual(new URL(page.url()).pathname, '/p/deleted/c/inaccessible')
  console.log('OK : reprise du fil et de la carte, repli après suppression du contexte.')

  // Les CLI restent désactivés côté serveur. Des sondes fixes rendent le formulaire
  // manipulable sans lancer un agent, et l'envoi est intercepté avant toute création.
  await page.route('**/api/agents', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.agents = json.agents.map((entry) => ({ ...entry, enabled: true, installed: true, reason: null, version: null }))
    await route.fulfill({ json })
  })
  await page.route('**/api/agents/*/models', (route) => route.fulfill({ json: { models: [], modes: [], account: null, fetchedAt: Date.now() } }))
  await page.route('**/api/projects/*/commands?*', (route) => route.fulfill({ json: { commands: [] } }))
  await page.route('**/api/agents/*/usage', (route) => route.fulfill({ json: {
    agent: route.request().url().includes('/codex/') ? 'codex' : 'claude', plan: 'Test', limitsAvailable: true, credits: null, fetchedAt: Date.now(),
    windows: [{ id: 'session', label: 'Session', utilization: 0.95, resetsAt: Date.now() + 3_600_000 }, { id: 'week', label: 'Semaine', utilization: 0.25, resetsAt: null }],
  } }))
  await page.goto(`${base}/p/${project.id}/c/new?agent=claude`)
  const message = page.getByPlaceholder('Écris ton message...')
  await message.waitFor()
  await message.fill('Un brouillon qui doit rester en changeant d’agent.')
  const claude = page.getByRole('radio', { name: 'Claude Code', exact: true })
  const codex = page.getByRole('radio', { name: 'Codex', exact: true })
  await claude.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await codex.isChecked(), true, 'Agent selection must support arrow keys')
  assert.equal(await message.inputValue(), 'Un brouillon qui doit rester en changeant d’agent.')
  const usage = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Consommation du compte' }) })
  await usage.getByText('Session · 95 %', { exact: true }).waitFor()
  assert.equal(await usage.getAttribute('open'), null)
  assert.equal(await usage.getByText('Session · 95 %', { exact: true }).isVisible(), true, 'A nearly exhausted quota must be visible while collapsed')
  await usage.locator('summary').click()
  await usage.getByText(/Remise à zéro/).waitFor()
  await usage.locator('summary').click()

  let submitted
  await page.route(`**/api/projects/${project.id}/conversations`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    submitted = route.request().postDataJSON()
    await route.fulfill({ status: 500, json: { error: { code: 'ui_test_failure', message: 'Simulated creation failure' } } })
  })
  assert.equal(submitted, undefined)
  await page.getByRole('button', { name: 'Envoyer le message', exact: true }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(submitted.agent, 'codex')
  assert.equal(submitted.worktreeId, null)
  assert.equal(submitted.firstMessage.text, await message.inputValue())
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    await page.evaluate(() => document.querySelector('main > div > div').scrollTop = 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Draft overflow at ${width}px`)
    const box = await page.getByRole('button', { name: 'Envoyer le message', exact: true }).boundingBox()
    assert.ok(box.y + box.height <= 844, `Send button below viewport at ${width}px`)
  }
  console.log('OK : choix de l’agent au clavier, brouillon conservé, quotas visibles et envoi accessible.')

  await page.goto(base + '/settings/apparence')
  await page.getByRole('heading', { name: 'Personnel', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Agents et projets', exact: true }).waitFor()
  await page.getByRole('heading', { name: 'Administration', exact: true }).waitFor()
  const size = page.getByRole('slider', { name: 'Taille du texte', exact: true })
  assert.equal(await size.getAttribute('aria-valuetext'), '15 px')
  await size.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await size.getAttribute('aria-valuetext'), '16 px')
  await page.reload()
  await size.waitFor()
  assert.equal(await size.getAttribute('aria-valuetext'), '16 px')


  const neutral = page.getByRole('radio', { name: 'Neutre', exact: true })
  await page.getByText('Réglages fins des couleurs', { exact: true }).click()
  const hue = page.getByRole('slider', { name: 'Teinte', exact: true })
  await hue.focus()
  await page.keyboard.press('ArrowRight')
  const customHue = await hue.inputValue()
  await neutral.check()
  assert.equal(await page.evaluate(() => localStorage.getItem('sillage.tint')), '0')
  assert.equal(await hue.inputValue(), customHue, 'A background preset preserves the accent hue')
  assert.equal(await size.getAttribute('aria-valuetext'), '16 px', 'A preset preserves reading settings')
  await page.reload()
  await neutral.waitFor()
  assert.equal(await neutral.isChecked(), true)
  await page.getByRole('radio', { name: 'Discret', exact: true }).check()
  assert.equal(await page.evaluate(() => localStorage.getItem('sillage.tint')), '0.25')
  await page.getByRole('button', { name: 'Sombre contrasté', exact: true }).click()
  assert.equal(await page.getByRole('radio', { name: 'Discret', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Clair', exact: true }).click()
  assert.equal(await page.getByRole('radio', { name: 'Discret', exact: true }).isChecked(), true)
  console.log('OK : ambiances persistantes, teinte et lecture conservées, thème contrasté respecté.')

  const createdUser = await context.request.post(base + '/api/users', { data: { username: 'ui-reader', displayName: 'UI Reader', password: 'ui-test-password', isAdmin: false } })
  assert.ok(createdUser.ok())
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block', storageState: await context.storageState() })
  const otherLogin = await other.request.post(base + '/api/auth/login', { data: { username: 'ui-reader', password: 'ui-test-password' } })
  assert.ok(otherLogin.ok())
  assert.equal((await other.request.get(`${base}/api/projects/${project.id}/file/download?path=package.json`)).status(), 404)
  assert.equal((await other.request.get(`${base}/api/conversations/${hero.id}/file/download?path=package.json`)).status(), 404)
  const otherPage = await other.newPage()
  otherPage.on('pageerror', (error) => errors.push(error.message))
  await otherPage.goto(base + '/settings/compte')
  await otherPage.getByRole('heading', { name: 'Personnel', exact: true }).waitFor()
  assert.equal(await otherPage.getByRole('heading', { name: 'Administration', exact: true }).count(), 0)
  await otherPage.evaluate(({ id, path }) => {
    localStorage.setItem(`sillage.lastContext:${id}`, path)
  }, { id: currentUser.id, path: `/p/${project.id}/board?carte=2` })
  await otherPage.goto(base + '/')
  const visibleProjects = await (await other.request.get(base + '/api/projects')).json()
  const visibleConversations = await (await other.request.get(base + '/api/conversations')).json()
  const mostRecent = visibleConversations.filter((entry) => !entry.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (mostRecent) await otherPage.waitForURL(`**/p/${mostRecent.projectId}/c/${mostRecent.id}`)
  else if (visibleProjects.length) await otherPage.waitForURL(`**/p/${visibleProjects[0].id}/c/new`)
  else await otherPage.getByRole('main').getByText('Aucun projet', { exact: true }).waitFor()
  assert.notEqual(new URL(otherPage.url()).pathname + new URL(otherPage.url()).search, `/p/${project.id}/board?carte=2`, 'One account must not resume the context of another')
  await other.close()
  console.log('OK : réglages regroupés, unités lisibles persistantes et séparation des comptes.')

  assert.deepEqual(errors, [])
  console.log('OK : aucune exception navigateur ni débordement du document de 320 à 1440 px.')
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}
