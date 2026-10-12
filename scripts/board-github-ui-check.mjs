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
import { startFakeGitHub } from './fake-github.mjs'

// Board relié aux issues GitHub, de bout en bout dans l'interface, contre un faux GitHub
// local : liaison, import, filtre, fil d'une issue, publication d'une note, colonne
// renvoyée à GitHub, carte créée en issue, carte locale publiée, déliaison.
// Les captures vont dans BOARD_GITHUB_SHOTS, ou dans un dossier temporaire.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-board-github-check-'))
const shots = process.env.BOARD_GITHUB_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-board-github-shots-')))
const processes = []
let browser
let github

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

async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(200)
  }
  throw new Error(message)
}

try {
  github = await startFakeGitHub()
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n')
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
    SILLAGE_GITHUB_API_URL: github.url,
  }
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  const api = `http://127.0.0.1:${apiPort}`
  await Promise.all([ready(`${api}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const project = (await (await context.request.get(`${base}/api/projects`)).json()).find((entry) => entry.name === 'Nimbus')
  const cardsOf = async () => (await context.request.get(`${base}/api/projects/${project.id}/cards`)).json()

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // Sans jeton GitHub, le dialogue le dit et renvoie vers les réglages.
  await page.goto(`${base}/p/${project.id}/board`)
  await page.getByRole('button', { name: 'Relier à GitHub' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('Aucun jeton GitHub sur ton compte').waitFor()
  assert.ok(await dialog.getByRole('button', { name: 'Relier', exact: true }).isDisabled())
  await page.keyboard.press('Escape')

  const credential = await context.request.put(`${base}/api/git-credentials`, { data: { host: 'github.com', token: 'fake-token' } })
  assert.ok(credential.ok(), await credential.text())
  await page.reload()
  await page.getByRole('button', { name: 'Relier à GitHub' }).click()
  await dialog.getByLabel('Dépôt').fill('acme/nimbus')
  await dialog.getByRole('radio', { name: /Locales/ }).waitFor()
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(shots, 'board-github-link.png') })
  await dialog.getByRole('button', { name: 'Relier', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })

  // Les issues ouvertes et la fermée récente arrivent ; ni la PR, ni la vieille fermée.
  await page.getByText('Crash when the cache folder is missing').waitFor({ timeout: 20000 })
  await until(async () => (await cardsOf()).filter((card) => card.external).length === 5, 'Five issues imported')
  const imported = (await cardsOf()).filter((card) => card.external).map((card) => card.external.number).sort((a, b) => a - b)
  assert.deepEqual(imported, [9, 12, 15, 18, 21])
  assert.equal((await cardsOf()).find((card) => card.external?.number === 18).column, 'in_progress')
  await page.getByRole('button', { name: /Liaison GitHub : acme\/nimbus/ }).waitFor()
  await page.screenshot({ path: join(shots, 'board-github-board.png') })

  // Le filtre : GitHub seules, puis locales seules.
  const localCount = (await cardsOf()).filter((card) => !card.external).length
  await page.getByRole('radio', { name: /^GitHub/ }).click()
  await until(async () => (await page.locator('[data-card-open]').count()) === 5, 'GitHub filter shows the issues')
  await page.screenshot({ path: join(shots, 'board-github-filter.png') })
  await page.getByRole('radio', { name: /^Locales/ }).click()
  await until(async () => (await page.locator('[data-card-open]').count()) === localCount, 'Local filter hides the issues')
  await page.getByRole('radio', { name: /^Toutes/ }).click()

  // Le fil d'une issue : les commentaires de la communauté, et une réponse publiée.
  await page.getByText('Crash when the cache folder is missing').click()
  const panel = page.getByRole('complementary', { name: /Carte/ })
  await panel.getByText('Issue #12, ouverte par @lena-k').waitFor()
  await panel.getByRole('button', { name: /Activité/ }).click()
  await panel.getByText('@marco-p').waitFor()
  await panel.getByLabel('Ajouter une note').fill('Thanks for the report, a fix is on the way.')
  await panel.getByLabel(/Publier aussi en commentaire sur l’issue #12|Publier aussi en commentaire sur l'issue #12/).check()
  await panel.getByRole('button', { name: 'Ajouter et publier' }).click()
  await until(() => github.comments.some((comment) => comment.body === 'Thanks for the report, a fix is on the way.'), 'Note posted to GitHub')
  await panel.getByText('sur GitHub', { exact: true }).waitFor({ timeout: 10000 })
  await page.screenshot({ path: join(shots, 'board-github-thread.png') })

  // Déplacer la carte la renvoie à GitHub : « Terminé » ferme l'issue.
  await panel.getByRole('button', { name: /Changer la colonne|Colonne/ }).first().click()
  await page.getByRole('menuitem', { name: 'Terminé' }).click()
  await until(() => github.issues.get(12).state === 'closed', 'Done closes the issue')
  await page.keyboard.press('Escape')

  // Une carte créée en issue depuis le dialogue.
  await page.goto(`${base}/p/${project.id}/board`)
  await page.getByRole('button', { name: 'Nouveau ticket' }).first().click()
  const create = page.getByRole('dialog')
  await create.getByLabel('Titre').fill('Document the cache folder')
  await create.getByRole('radio', { name: /Issue sur acme\/nimbus/ }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'board-github-create.png') })
  await create.getByRole('button', { name: 'Créer le ticket' }).click()
  await create.waitFor({ state: 'detached' })
  assert.ok([...github.issues.values()].some((issue) => issue.title === 'Document the cache folder'))

  // Une carte locale publiée par le menu GitHub du panneau.
  const local = (await cardsOf()).find((card) => !card.external)
  await page.goto(`${base}/p/${project.id}/board?carte=${local.number}`)
  const localPanel = page.getByRole('complementary', { name: /Carte/ })
  await localPanel.getByRole('button', { name: 'GitHub' }).click()
  await page.getByRole('menuitem', { name: 'Publier sur GitHub' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Publier sur GitHub' }).click()
  await until(() => [...github.issues.values()].some((issue) => issue.title === local.title), 'Local card published')

  // Au téléphone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block', storageState: await context.storageState() })
  await phone.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const mobile = await phone.newPage()
  mobile.on('pageerror', (error) => errors.push(error.message))
  await mobile.goto(`${base}/p/${project.id}/board`)
  await mobile.getByRole('radio', { name: /^GitHub/ }).waitFor()
  await mobile.screenshot({ path: join(shots, 'board-github-phone.png') })
  await mobile.getByRole('button', { name: /Liaison GitHub/ }).click()
  await mobile.getByRole('dialog').getByText('acme/nimbus').first().waitFor()
  await mobile.waitForTimeout(300)
  await mobile.screenshot({ path: join(shots, 'board-github-phone-settings.png') })
  await mobile.getByRole('dialog').getByRole('tab', { name: 'Maintenance' }).click()
  await mobile.getByRole('dialog').getByRole('switch', { name: 'Nouvelle issue' }).waitFor()
  await mobile.waitForTimeout(300)
  await mobile.screenshot({ path: join(shots, 'board-github-phone-maintenance.png') })
  await phone.close()

  // Maintenance : les deux déclencheurs, leurs instructions, l'identité, la session.
  await page.goto(`${base}/p/${project.id}/board`)
  await page.getByRole('button', { name: /Liaison GitHub/ }).click()
  const settings = page.getByRole('dialog')
  await settings.getByText('Synchronisé il y a', { exact: false }).waitFor()
  await page.screenshot({ path: join(shots, 'board-github-settings.png') })
  await settings.getByRole('tab', { name: 'Maintenance' }).click()
  await settings.getByRole('switch', { name: 'Nouvelle issue' }).click()
  await settings.getByLabel('Que faire d’une nouvelle issue').fill('Reproduis le bug puis réponds avec ton analyse.')
  await settings.getByRole('switch', { name: 'Nouveau commentaire' }).click()
  await settings.getByLabel('Que faire d’un nouveau commentaire').fill('Réponds aux questions posées.')
  await settings.getByLabel('Manière de répondre').fill('En anglais, bref.')
  await settings.getByRole('radio', { name: /Comme le développeur/ }).click()
  assert.equal(await settings.getByLabel('Signature').count(), 0, 'No signature field when the agent speaks as the developer')
  await settings.getByRole('radio', { name: /Arbre principal/ }).click()
  await settings.getByLabel('Sessions et commentaires par heure, au plus').fill('5')
  await page.waitForTimeout(300)
  // Le dialogue défile à l'intérieur : une capture par hauteur, du haut vers le bas.
  const scroller = settings.locator('form > div').first()
  for (const [index, ratio] of [0, 0.5, 1].entries()) {
    await scroller.evaluate((node, at) => { node.scrollTop = (node.scrollHeight - node.clientHeight) * at }, ratio)
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(shots, `board-github-maintenance-${index + 1}.png`) })
  }
  await settings.getByRole('button', { name: 'Enregistrer' }).click()
  await until(async () => {
    const state = await (await context.request.get(`${base}/api/projects/${project.id}/board-link`)).json()
    return state.link.onIssue && state.link.onComment && state.link.identity === 'developer' && state.link.workspace === 'root' && state.link.maxSessionsPerHour === 5
  }, 'Maintenance settings saved')
  const saved = (await (await context.request.get(`${base}/api/projects/${project.id}/board-link`)).json()).link
  assert.equal(saved.issueInstructions, 'Reproduis le bug puis réponds avec ton analyse.')
  assert.equal(saved.replyStyle, 'En anglais, bref.')
  // Coupés avant la suite : aucune vraie session ne doit partir pendant le contrôle.
  await context.request.put(`${base}/api/projects/${project.id}/board-link`, { data: { ...saved, onIssue: false, onComment: false } })
  await page.keyboard.press('Escape')

  // Délier : les cartes GitHub sans travail local partent.
  await page.reload()
  await page.getByRole('button', { name: /Liaison GitHub/ }).click()
  await page.getByRole('dialog').getByText('Synchronisé il y a', { exact: false }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Délier' }).click()
  await page.getByRole('dialog', { name: /Délier acme\/nimbus/ }).getByRole('button', { name: 'Délier' }).click()
  await until(async () => (await cardsOf()).every((card) => !card.external || card.external.detached), 'Unlinked')
  assert.ok((await cardsOf()).some((card) => card.external?.number === 12), 'The card with a local note stays')
  await page.getByRole('button', { name: 'Relier à GitHub' }).waitFor()

  assert.deepEqual(errors, [])
  console.log(`Board GitHub : parcours complet vérifié. Captures dans ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await github?.close()
  await rm(data, { recursive: true, force: true })
}
