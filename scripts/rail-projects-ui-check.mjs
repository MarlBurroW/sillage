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

// The rail's projects: what adds one, what removes it, and the entry that stays in reach.
// Real components and API, temporary database. No CLI enabled.
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
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok'].map(agent => `[agents.${agent}]\nenabled = false\n`).join(''))
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
  await context.addInitScript(() => { localStorage.setItem('sillage.locale', 'fr'); localStorage.setItem('sillage.theme', 'dark') })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(12000)
  await page.goto(base)
  await page.getByRole('textbox', { name: "Nom d'utilisateur", exact: true }).fill('alex')
  await page.getByRole('textbox', { name: 'Mot de passe', exact: true }).fill('sillage-demo')
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  await page.waitForURL(/\/p\/[^/]+\/c\/[^/]+$/)
  const shots = process.env.SILLAGE_UI_SHOTS ?? await mkdtemp(join(tmpdir(), 'sillage-rail-shots-'))
  await mkdir(shots, { recursive: true })

  const listProjects = async () => (await context.request.get(`${base}/api/projects`)).json()
  const pinned = async () => (await listProjects()).filter((entry) => entry.pinned).map((entry) => entry.name).sort()
  const workspaces = join(data, 'workspaces')
  await mkdir(workspaces, { recursive: true })
  const names = ['Borealis', 'Cobalt', 'Delta Sync', 'Ember', 'Fathom', 'Garnet', 'Halcyon', 'Iris', 'Juniper', 'Kestrel', 'Lumen', 'Meridian', 'Nova', 'Onyx']
  for (const name of names) {
    const response = await context.request.post(`${base}/api/projects`, { data: { name, parentDir: workspaces, directory: name.toLowerCase().replace(/\s+/g, '-'), visibility: 'private' } })
    assert.equal(response.status(), 201, await response.text())
  }
  const projects = await listProjects()
  const byName = (name) => projects.find((entry) => entry.name === name)
  const nimbus = byName('Nimbus')
  await page.goto(`${base}/p/${nimbus.id}/board`)

  const sidebar = page.locator('.sidebar-layout:visible')
  const rail = sidebar.locator('[data-nav-rail]')
  const marks = rail.locator('[data-nav-space^="project:"]')
  const mark = (project) => rail.locator(`[data-nav-space="project:${project.id}"]`)
  const add = rail.locator('[data-nav-add-project]')
  const picker = page.getByRole('dialog', { name: 'Projets du rail' })
  const shown = (count) => page.waitForFunction((expected) => document.querySelectorAll('.sidebar-layout [data-nav-rail] [data-nav-space^="project:"]').length === expected, count)

  // Without pins the rail stands in with a few projects; nothing is written yet.
  await shown(6)
  assert.deepEqual(await pinned(), [])
  assert.equal(await rail.locator('[data-nav-visiting]').count(), 0)
  await add.hover()
  await page.getByRole('tooltip').filter({ hasText: 'Ajouter au rail' }).waitFor()
  await page.screenshot({ path: join(shots, 'rail.png') })

  // The entry opens a panel beside the rail, not a dialog over it: the rail stays in view.
  await add.click()
  await picker.waitFor()
  assert.equal(await page.locator('[data-projects-dialog]').count(), 0)
  await assertInside(picker, 1440, 900)
  assert.ok((await picker.boundingBox()).x >= (await rail.boundingBox()).width, 'The panel leaves the rail in view')
  const implicit = await marks.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label').split(' — ')[0]).sort())
  assert.equal(await picker.getByRole('region', { name: 'Dans le rail' }).locator('[data-project-row]').count(), 6)
  await page.screenshot({ path: join(shots, 'picker.png') })

  // The first choice writes down the rail as it stands plus this project: none it showed drops out.
  const outside = names.find((name) => !implicit.includes(name))
  await picker.getByRole('textbox', { name: 'Rechercher un projet…' }).fill(outside.slice(0, 4))
  const before = await picker.boundingBox()
  await picker.getByRole('button', { name: `Ajouter ${outside} au rail`, exact: true }).click()
  await shown(7)
  await picker.getByRole('button', { name: `Retirer ${outside} du rail`, exact: true }).waitFor()
  assert.ok(await picker.isVisible(), 'Adding keeps the panel open for the next one')
  // The entry moved down with the new mark; the panel and the row under the pointer did not.
  assert.deepEqual(await picker.boundingBox(), before)
  await page.waitForFunction(async (expected) => (await (await fetch('/api/projects')).json()).filter((entry) => entry.pinned).length === expected, 7)
  assert.deepEqual(await pinned(), [...implicit, outside].sort())
  await page.screenshot({ path: join(shots, 'picker-added.png') })
  // The same button takes it off again.
  await picker.getByRole('button', { name: `Retirer ${outside} du rail`, exact: true }).click()
  await shown(6)
  await picker.getByRole('textbox', { name: 'Rechercher un projet…' }).fill('')

  // A row opens its project. Not kept, it shows apart while open and leaves with the next space.
  const guest = byName(names.filter((name) => !implicit.includes(name))[1])
  await picker.getByRole('button', { name: guest.name, exact: true }).click()
  await picker.waitFor({ state: 'detached' })
  await page.waitForURL(`**/p/${guest.id}/**`)
  await rail.locator(`[data-nav-visiting][data-nav-space="project:${guest.id}"][aria-current="page"]`).waitFor()
  await shown(7)
  await page.screenshot({ path: join(shots, 'visiting.png') })
  await mark(nimbus).click()
  await shown(6)
  // Right click keeps it; the same menu removes a kept one.
  await add.click()
  await picker.getByRole('button', { name: guest.name, exact: true }).click()
  await rail.locator('[data-nav-visiting]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Ajouter au rail', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-layout [data-nav-visiting]').length === 0)
  await shown(7)
  await mark(guest).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Retirer du rail', exact: true }).click()
  await rail.locator('[data-nav-visiting]').waitFor()
  await mark(nimbus).click()
  await shown(6)

  // More projects than the rail can show: the list scrolls and the entry that adds one stays put.
  for (const name of names) {
    if ((await pinned()).includes(name)) continue
    assert.equal((await context.request.put(`${base}/api/projects/${byName(name).id}/pin`, { data: {} })).status(), 200)
  }
  await page.setViewportSize({ width: 1440, height: 640 })
  await page.reload()
  await add.waitFor()
  const list = rail.locator('.nav-rail-projects-list')
  await list.locator('[data-more-below]').or(rail.locator('.nav-rail-projects-list[data-more-below]')).first().waitFor()
  assert.ok(await list.evaluate((node) => node.scrollHeight > node.clientHeight), 'The kept projects scroll')
  await assertInside(add, 1440, 640)
  const utilities = await rail.locator('.sidebar-utilities').boundingBox()
  const addBox = await add.boundingBox()
  assert.ok(addBox.y + addBox.height <= utilities.y, 'The add entry stays above the utilities')
  await list.evaluate((node) => { node.scrollTop = node.scrollHeight })
  await rail.locator('.nav-rail-projects-list[data-more-above]:not([data-more-below])').waitFor()
  assert.deepEqual(await add.boundingBox(), addBox)
  await page.screenshot({ path: join(shots, 'rail-scrolled.png') })
  await add.click()
  await picker.waitFor()
  await assertInside(picker, 1440, 640)
  await page.screenshot({ path: join(shots, 'picker-short.png') })

  // The full list: same rail button, a filter, and creation where it cannot be missed.
  await picker.getByRole('button', { name: 'Gérer les projets', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^Projets/ })
  await dialog.waitFor()
  await picker.waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(shots, 'dialog.png') })
  await dialog.getByRole('radio', { name: 'Autres', exact: true }).click()
  await dialog.getByText('Tous tes projets sont dans le rail.').waitFor()
  await dialog.getByRole('radio', { name: 'Tous', exact: true }).click()
  await dialog.getByRole('button', { name: 'Retirer Onyx du rail', exact: true }).click()
  await dialog.getByRole('button', { name: 'Ajouter Onyx au rail', exact: true }).waitFor()
  await dialog.getByRole('radio', { name: 'Autres', exact: true }).click()
  assert.equal(await dialog.locator('[data-project-choice]').count(), 1)
  await dialog.getByRole('textbox', { name: 'Rechercher un projet…' }).fill('introuvablexyz')
  await dialog.getByText('Aucun projet trouvé').waitFor()
  await dialog.getByRole('textbox', { name: 'Rechercher un projet…' }).fill('')
  await dialog.getByRole('radio', { name: 'Tous', exact: true }).click()
  await dialog.getByRole('button', { name: 'Réglages du projet' }).first().waitFor()
  await dialog.getByRole('button', { name: 'Nouveau projet', exact: true }).click()
  await page.waitForURL('**/projects/new')
  await dialog.waitFor({ state: 'detached' })

  // A project created here joins a rail its account composed.
  await page.getByLabel('Nom', { exact: true }).fill('Zephyr')
  await page.getByLabel('Dossier des projets', { exact: true }).fill(workspaces)
  await page.getByRole('button', { name: 'Créer le projet', exact: true }).click()
  await page.waitForURL(/\/p\/[^/]+\/c\/new$/)
  await rail.locator('[data-nav-space^="project:"][aria-current="page"]:not([data-nav-visiting])').waitFor()
  assert.ok((await pinned()).includes('Zephyr'))
  // The open project is brought into view even at the end of a long rail.
  await page.setViewportSize({ width: 1440, height: 640 })
  await assertInside(rail.locator('[data-nav-space^="project:"][aria-current="page"]'), 1440, 640)

  // On a phone the same panel opens from the drawer and fits beside the rail.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block', storageState: await context.storageState() })
  const phone = await mobile.newPage()
  phone.setDefaultTimeout(12000)
  phone.on('pageerror', (error) => errors.push(error.message))
  await phone.goto(`${base}/p/${nimbus.id}/board`)
  await phone.locator('[data-navigation-trigger]').click()
  const drawer = phone.locator('.sidebar-layout:visible')
  await drawer.locator('[data-nav-add-project]').tap()
  const sheet = phone.getByRole('dialog', { name: 'Projets du rail' })
  await sheet.waitFor()
  await assertInside(sheet, 390, 844)
  assert.ok((await sheet.boundingBox()).x >= (await drawer.locator('[data-nav-rail]').boundingBox()).width, 'The panel leaves the rail in view')
  await phone.screenshot({ path: join(shots, 'mobile-picker.png') })
  await sheet.getByRole('button', { name: 'Ajouter Onyx au rail', exact: true }).tap()
  await sheet.getByRole('button', { name: 'Retirer Onyx du rail', exact: true }).waitFor()
  await sheet.getByRole('button', { name: 'Gérer les projets', exact: true }).tap()
  const phoneDialog = phone.getByRole('dialog', { name: /^Projets/ })
  await phoneDialog.waitFor()
  await assertInside(phoneDialog, 390, 844)
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.screenshot({ path: join(shots, 'mobile-dialog.png') })
  await mobile.close()

  assert.deepEqual(errors, [])
  console.log(`Rail projects verified: implicit rail, first choice, add and remove, visiting, scroll, full list, creation, phone. Screenshots: ${shots}`)
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}

async function assertInside(locator, width, height) {
  const box = await locator.boundingBox()
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `Out of the ${width}×${height} viewport: ${JSON.stringify(box)}`)
}
