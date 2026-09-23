import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

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
  const shots = join(root, 'docs/audits/2026-09-19-board')
  await mkdir(shots, { recursive: true })
  await page.goto(board)
  await page.getByRole('button', { name: 'Nouveau ticket', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Nouveau ticket', exact: true })
  await dialog.getByRole('textbox', { name: 'Titre', exact: true }).fill('Améliorer l’accueil du projet')
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('## Objectif\nRetrouver les informations utiles dès l’ouverture du projet.\n\n- Afficher les tickets à vérifier\n- Reprendre la dernière session\n- Donner accès aux documents de référence\n\nVoir aussi #2 pour le fonctionnement hors ligne.')
  await dialog.getByRole('button', { name: 'Aperçu', exact: true }).click()
  await dialog.getByRole('heading', { name: 'Objectif', exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Écrire', exact: true }).click()
  // Annuler ferme et conserve le brouillon ; ne doit jamais soumettre le formulaire.
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).click()
  assert.equal((await (await context.request.get(`${base}/api/projects/${project.id}/cards`)).json()).length, cards.length)
  await page.getByRole('button', { name: 'Nouveau ticket', exact: true }).click()
  assert.equal(await dialog.getByRole('textbox', { name: 'Titre', exact: true }).inputValue(), 'Améliorer l’accueil du projet')
  await dialog.getByRole('button', { name: 'Créer le ticket', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const ticket = page.getByRole('complementary', { name: /^Carte #/ })
  await ticket.getByRole('heading', { name: 'Améliorer l’accueil du projet', exact: true }).waitFor()
  await ticket.getByRole('button', { name: 'Modifier la carte', exact: true }).click()
  const editor = ticket.getByRole('textbox', { name: 'Description', exact: true })
  await editor.fill((await editor.inputValue()) + '\n\nTexte validé.')
  assert.equal(await ticket.getByRole('button', { name: 'Lancer une session', exact: true }).isDisabled(), true)
  await editor.press('Control+Enter')
  await ticket.getByRole('button', { name: 'Modifier la carte', exact: true }).waitFor()
  assert.equal(await ticket.getByRole('button', { name: 'Lancer une session', exact: true }).isEnabled(), true)
  const number = Number(new URL(page.url()).searchParams.get('carte'))
  const created = (await (await context.request.get(`${base}/api/projects/${project.id}/cards`)).json()).find((entry) => entry.number === number)
  assert.ok(created)
  const files = ticket.getByRole('region', { name: 'Pièces jointes', exact: true })
  await files.locator('input[type=file]').setInputFiles([
    { name: 'brief.md', mimeType: 'text/markdown', buffer: Buffer.from('# Brief\nInformations accessibles aux agents.') },
    { name: 'reference.png', mimeType: 'image/png', buffer: await page.screenshot() },
  ])
  await files.getByRole('link', { name: /brief.md/ }).waitFor()
  await files.getByRole('link', { name: /reference.png/ }).waitFor()
  const attached = (await (await context.request.get(`${base}/api/cards/${created.id}/attachments`)).json())
  assert.equal(attached.length, 2)
  const download = await context.request.get(`${base}/api/attachments/${attached[0].id}`)
  assert.ok(download.ok())
  assert.equal(await download.text(), '# Brief\nInformations accessibles aux agents.')
  const beforeErrors = await files.getByRole('alert').count()
  await page.route(`**/api/cards/${created.id}/attachments`, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { error: { code: 'test', message: 'Erreur simulée' } } }) : route.continue())
  await files.locator('input[type=file]').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('Retry') })
  await files.getByRole('alert').filter({ hasText: 'Erreur simulée' }).waitFor()
  assert.equal(await files.getByRole('alert').count(), beforeErrors + 1)
  await page.unroute(`**/api/cards/${created.id}/attachments`)
  await files.locator('div.border-dashed').evaluate((node) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Retry'], 'retry.txt', { type: 'text/plain' }))
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
  })
  await files.getByRole('link', { name: /retry.txt/ }).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await files.getByRole('button', { name: 'Retirer retry.txt', exact: true }).click()
  await files.getByRole('link', { name: /retry.txt/ }).waitFor({ state: 'hidden' })
  await ticket.getByRole('button', { name: 'Activité 0', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Ajouter une note', exact: true }).fill('Les documents de référence sont joints au ticket.')
  await ticket.getByRole('button', { name: 'Ajouter une note', exact: true }).click()
  await ticket.getByText('Les documents de référence sont joints au ticket.', { exact: true }).waitFor()
  await ticket.getByRole('button', { name: 'Détails', exact: true }).click()
  await ticket.getByRole('button', { name: 'Fermer', exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Rechercher un ticket, un numéro…', exact: true })
  await search.fill(`#${number}`)
  await page.locator(`[data-card-open="${created.id}"]`).waitFor()
  assert.equal(await page.locator('[data-card-open]').count(), 1)
  assert.equal(await page.getByRole('button', { name: /^Déplacer la carte/ }).count(), 0, 'Filtering cannot reorder partial columns')
  await search.fill('aucun-resultat-123')
  await page.getByText('Aucun ticket ne correspond à ta recherche.').waitFor()
  await search.fill('')
  // Déplacement clavier : le tri reste utilisable sans souris.
  const handle = page.getByRole('button', { name: `Déplacer la carte #${number}`, exact: true })
  await handle.focus()
  await page.keyboard.press('Space')
  await page.waitForTimeout(150)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(150)
  const reordered = page.waitForResponse((response) => response.url().endsWith('/cards/order'))
  await page.keyboard.press('Space')
  assert.ok((await reordered).ok())
  await page.waitForTimeout(300)
  assert.equal(await page.locator('[data-card-open]').count(), cards.length + 1)
  await page.screenshot({ animations: 'disabled', path: join(shots, 'board-desktop.png') })
  await page.locator(`[data-card-open="${created.id}"]`).click()
  await ticket.getByRole('button', { name: 'Modifier la carte', exact: true }).click()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'ticket-editor-desktop.png') })
  await ticket.getByRole('button', { name: 'Annuler', exact: true }).click()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const mobileTicket = page.getByRole('dialog', { name: `Carte #${number}`, exact: true })
    await mobileTicket.waitFor()
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await mobileTicket.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
    if (width === 390) await page.screenshot({ animations: 'disabled', path: join(shots, 'ticket-mobile.png') })
  }
  await page.getByRole('button', { name: 'Fermer', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await page.screenshot({ animations: 'disabled', path: join(shots, 'board-mobile.png') })
  await search.fill('#2')
  await page.locator(`[data-card-open="${card.id}"]`).waitFor()
  assert.equal(await page.getByRole('region', { name: 'En cours', exact: true }).isVisible(), true, 'Mobile search switches to the matching column')
  await search.fill('')
  await page.getByRole('button', { name: 'Nouveau ticket', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Titre', exact: true }).fill('Vérification mobile')
  const createBox = await dialog.getByRole('button', { name: 'Créer le ticket', exact: true }).boundingBox()
  assert.ok(createBox.y + createBox.height <= 844, 'The mobile creation action remains visible')
  await page.screenshot({ animations: 'disabled', path: join(shots, 'create-mobile.png') })
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ animations: 'disabled', path: join(shots, 'board-dark.png') })
  assert.deepEqual(errors, [])
  console.log('OK : création et brouillon, aperçu Markdown, pièces multiples, téléchargement, erreur/réessai, retrait, notes, recherche, clavier et mobile ; captures dans ' + shots)
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
