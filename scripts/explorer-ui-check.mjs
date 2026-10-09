import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Explorateur de fichiers : sélection multiple, clavier, presse-papiers, archive et
// mode sélection au doigt. Base, projet et serveurs jetables, comme les autres contrôles.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const require = createRequire(join(serverDir, 'package.json'))
const { unzipSync } = require('fflate')
const data = await mkdtemp(join(tmpdir(), 'sillage-explorer-ui-'))
const children = []
let browser

async function port() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const number = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return number
}

function run(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'pipe' })
  children.push(child)
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
  throw new Error(`Service did not start: ${child.diagnostics}`)
}

const exists = (path) => access(path).then(() => true, () => false)

async function until(check, message) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(message)
}

try {
  const [apiPort, webPort] = await Promise.all([port(), port()])
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: join(data, 'web') }
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)
  const Sqlite = require('better-sqlite3')
  const db = new Sqlite(join(env.SILLAGE_DATA_DIR, 'sillage.db'), { readonly: true })
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get('Nimbus')
  const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? LIMIT 1').get(project.id)
  db.close()

  // Un dossier à soi dans le workspace de démonstration, trié en tête de la racine.
  const fixture = join(project.workspace_path, 'aa-explorer')
  await mkdir(join(fixture, 'inner'), { recursive: true })
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.md']) await writeFile(join(fixture, name), `${name}\n`)

  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])

  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block', acceptDownloads: true })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  await context.addInitScript(() => {
    localStorage.setItem('sillage.locale', 'fr')
    localStorage.setItem('sillage.panelOpen', '1')
  })
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  const panel = page.locator('[data-panel="workspace"]')
  const row = (path) => panel.locator(`[data-tree-path="aa-explorer${path ? `/${path}` : ''}"]`)
  const selected = async () =>
    (await panel.locator('[role=treeitem][aria-selected=true]').evaluateAll((rows) => rows.map((row) => row.dataset.treePath))).sort()
  const bar = panel.getByRole('toolbar', { name: 'Actions sur la sélection' })

  await row('').click()
  await row('a.txt').click()
  assert.deepEqual(await selected(), ['aa-explorer/a.txt'])

  // Maj-clic étend depuis le dernier clic, Ctrl-clic coche ou décoche. Les dossiers
  // passent avant les fichiers : `inner` est en tête.
  await row('d.md').click({ modifiers: ['Shift'] })
  assert.deepEqual(await selected(), ['aa-explorer/a.txt', 'aa-explorer/b.txt', 'aa-explorer/c.txt', 'aa-explorer/d.md'])
  await bar.getByText('4 sélectionnés').waitFor()
  await row('b.txt').click({ modifiers: ['ControlOrMeta'] })
  await row('inner').click({ modifiers: ['ControlOrMeta'] })
  assert.deepEqual(await selected(), ['aa-explorer/a.txt', 'aa-explorer/c.txt', 'aa-explorer/d.md', 'aa-explorer/inner'])
  // Les lignes changent de fond en transition : la capture attend qu'elle soit finie.
  await delay(200)
  await page.screenshot({ path: '/tmp/sillage-explorer-selection.png' })

  // Clavier : la sélection suit le curseur, s'étend à la Maj.
  await row('a.txt').click()
  await page.keyboard.press('ArrowDown')
  assert.deepEqual(await selected(), ['aa-explorer/b.txt'])
  await page.keyboard.press('Shift+ArrowDown')
  assert.deepEqual(await selected(), ['aa-explorer/b.txt', 'aa-explorer/c.txt'])
  await page.keyboard.press('Escape')
  assert.deepEqual(await selected(), [])

  // Copier deux fichiers, puis les coller dans `inner`.
  await row('b.txt').click()
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('ControlOrMeta+c')
  await panel.getByText('2 éléments copiés').waitFor()
  await row('inner').click()
  await page.keyboard.press('ControlOrMeta+v')
  await until(async () => (await exists(join(fixture, 'inner/b.txt'))) && (await exists(join(fixture, 'inner/c.txt'))), 'Paste did not copy')
  await row('inner/c.txt').waitFor()
  assert.deepEqual(await selected(), ['aa-explorer/inner/b.txt', 'aa-explorer/inner/c.txt'])

  // Dupliquer au clic droit, puis couper-coller.
  await row('a.txt').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Dupliquer' }).click()
  await until(() => exists(join(fixture, 'a copy.txt')), 'Duplicate failed')
  await row('d.md').click()
  await page.keyboard.press('ControlOrMeta+x')
  assert.equal(await row('d.md').evaluate((node) => getComputedStyle(node.parentElement).opacity), '0.5')
  await row('inner').click()
  await page.keyboard.press('ControlOrMeta+v')
  await until(async () => (await exists(join(fixture, 'inner/d.md'))) && !(await exists(join(fixture, 'd.md'))), 'Cut/paste did not move')

  // Glisser deux fichiers sélectionnés sur un dossier les déplace tous les deux.
  await row('a.txt').click()
  await row('a copy.txt').click({ modifiers: ['ControlOrMeta'] })
  await row('a.txt').dragTo(row('inner'))
  await until(async () => (await exists(join(fixture, 'inner/a.txt'))) && (await exists(join(fixture, 'inner/a copy.txt'))), 'Drag did not move the selection')
  // L'onglet ouvert sur a.txt suit son fichier.
  const tabs = panel.locator('[data-file-tabs]')
  await tabs.locator('[aria-label="Ouvrir aa-explorer/inner/a.txt"]').waitFor()
  assert.equal(await tabs.locator('[aria-label="Ouvrir aa-explorer/a.txt"]').count(), 0)

  // Supprimer une sélection passe par une seule confirmation.
  await row('inner/a.txt').click()
  await row('inner/a copy.txt').click({ modifiers: ['ControlOrMeta'] })
  await page.keyboard.press('Delete')
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'))
  await dialog.getByText('Supprimer ces 2 éléments ?').waitFor()
  await dialog.getByRole('button', { name: 'Supprimer', exact: true }).click()
  await until(async () => !(await exists(join(fixture, 'inner/a.txt'))) && !(await exists(join(fixture, 'inner/a copy.txt'))), 'Delete failed')
  // Sans brouillon, l'onglet d'un fichier supprimé se ferme.
  await tabs.locator('[aria-label^="Ouvrir aa-explorer/inner/a"]').waitFor({ state: 'detached' })

  // Copier le chemin relatif, et télécharger un dossier en zip.
  await row('inner').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copier le chemin relatif' }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'aa-explorer/inner')
  await row('inner').click({ button: 'right' })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Télécharger en .zip' }).click()])
  assert.equal(download.suggestedFilename(), 'inner.zip')
  const zipped = Object.keys(unzipSync(new Uint8Array(await readFile(await download.path())))).sort()
  assert.deepEqual(zipped, ['inner/', 'inner/b.txt', 'inner/c.txt', 'inner/d.md'])

  // Les dossiers dépliés survivent à une recherche, et se replient d'un geste.
  await panel.getByRole('searchbox').fill('b.txt')
  await panel.locator('[data-tree-path="aa-explorer/b.txt"]').waitFor()
  await panel.getByRole('searchbox').fill('')
  assert.equal(await row('inner').getAttribute('aria-expanded'), 'true')
  await panel.getByRole('button', { name: 'Replier tous les dossiers' }).click()
  assert.equal(await row('').getAttribute('aria-expanded'), 'false')

  // Taper le début d'un nom y amène.
  await row('').click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('c')
  assert.deepEqual(await selected(), ['aa-explorer/c.txt'])
  await delay(200)
  await page.screenshot({ path: '/tmp/sillage-explorer-desktop.png' })

  // Au doigt : « Sélectionner » ouvre le mode sélection, où un appui coche.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await phone.addInitScript(() => {
    localStorage.setItem('sillage.locale', 'fr')
    localStorage.setItem('sillage.panelOpen', '1')
  })
  assert.ok((await phone.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const mobile = await phone.newPage()
  mobile.on('pageerror', (error) => errors.push(error.message))
  await mobile.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  const mobilePanel = mobile.locator('[data-panel="workspace"]')
  const mobileRow = (path) => mobilePanel.locator(`[data-tree-path="aa-explorer/${path}"]`)
  await mobilePanel.locator('[data-tree-path="aa-explorer"]').tap()
  await mobilePanel.getByRole('button', { name: 'Actions de b.txt' }).tap()
  await mobile.getByRole('menuitem', { name: 'Sélectionner' }).tap()
  await mobileRow('c.txt').tap()
  await mobilePanel.getByRole('toolbar').getByText('2 sélectionnés').waitFor()
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await delay(200)
  await mobile.screenshot({ path: '/tmp/sillage-explorer-mobile.png' })
  await mobilePanel.getByRole('toolbar').getByRole('button', { name: 'Tout désélectionner' }).tap()
  await mobilePanel.getByRole('toolbar').waitFor({ state: 'detached' })

  assert.deepEqual(errors, [])
  console.log('OK : sélection multiple, clavier, copier/couper/coller, glisser, suppression groupée, zip, recherche et mode sélection au doigt.')
} finally {
  await browser?.close()
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  }
  await rm(data, { recursive: true, force: true })
}
