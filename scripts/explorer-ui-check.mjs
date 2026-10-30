import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// File explorer: multiple selection, keyboard, clipboard, archive, touch selection
// mode. Disposable database/project/servers, like the other checks.
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

  // Own directory in demo workspace, sorted first at root.
  const fixture = join(project.workspace_path, 'aa-explorer')
  await mkdir(join(fixture, 'inner'), { recursive: true })
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.md']) await writeFile(join(fixture, name), `${name}\n`)
  // Editor files apart, so they stay out of the ranges selected above.
  const editorFixture = join(project.workspace_path, 'ab-editor')
  await mkdir(editorFixture)
  await writeFile(join(editorFixture, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n')
  await writeFile(join(editorFixture, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  await writeFile(join(editorFixture, 'draft.txt'), 'draft base\n')
  const lines = (count, change = () => null) => Array.from({ length: count }, (_, index) => change(index + 1) ?? `line ${index + 1}`).join('\n') + '\n'
  await writeFile(join(editorFixture, 'live.txt'), lines(12))
  await writeFile(join(editorFixture, 'long.txt'), lines(300))
  // Tracked file deep in the tree, whose ancestors must follow its Git color.
  await mkdir(join(project.workspace_path, 'ac-tracked/deep/nested'), { recursive: true })
  await writeFile(join(project.workspace_path, 'ac-tracked/deep/nested/file.ts'), 'export {}\n')
  const git = (...args) => execFileSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@example.com', ...args], { cwd: project.workspace_path })
  git('add', 'ac-tracked')
  git('commit', '-qm', 'Track the explorer check fixture')
  // Search fixtures: a file found by its initials, and an ignored one the explorer still offers.
  await writeFile(join(editorFixture, 'forecast-cache.ts'), 'export {}\n')
  await writeFile(join(editorFixture, '.env.local'), 'TOKEN=x\n')
  await writeFile(join(project.workspace_path, '.git/info/exclude'), '.env.local\n', { flag: 'a' })
  // A level beyond the server's limit of 1000 entries.
  await mkdir(join(project.workspace_path, 'ad-many'))
  for (let index = 1; index <= 1003; index += 1) await writeFile(join(project.workspace_path, 'ad-many', `f${index}`), '')

  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])

  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block', acceptDownloads: true })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  // No CLI runs here: without a catalog, the composer's model list fails with a console error.
  await context.route('**/api/agents/*/models*', (route) => route.fulfill({ json: { models: [], modes: [], account: null, fetchedAt: Date.now() } }))
  await context.addInitScript(() => {
    localStorage.setItem('sillage.locale', 'fr')
    localStorage.setItem('sillage.panelOpen', '1')
    // Wide enough for the tree to stay beside the editor: narrower, opening a file closes it.
    localStorage.setItem('sillage.sheetWidth', '1000')
    localStorage.setItem('sillage.panelDockedWidth', '1000')
  })
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  // Browsers log failed requests without their URL: keep it, or a failure says nothing useful.
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.request().method()} ${response.url().replace(base, '')}`) })
  await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  const panel = page.locator('[data-panel="workspace"]')
  const row = (path) => panel.locator(`[data-tree-path="aa-explorer${path ? `/${path}` : ''}"]`)
  const selected = async () =>
    (await panel.locator('[role=treeitem][aria-selected=true]').evaluateAll((rows) => rows.map((row) => row.dataset.treePath))).sort()
  const bar = panel.getByRole('toolbar', { name: 'Actions sur la sélection' })

  await row('').click()
  await row('a.txt').click()
  assert.deepEqual(await selected(), ['aa-explorer/a.txt'])

  // Shift-click extends from last click; Ctrl-click toggles. Directories sort
  // before files: `inner` comes first.
  await row('d.md').click({ modifiers: ['Shift'] })
  assert.deepEqual(await selected(), ['aa-explorer/a.txt', 'aa-explorer/b.txt', 'aa-explorer/c.txt', 'aa-explorer/d.md'])
  await bar.getByText('4 sélectionnés').waitFor()
  await row('b.txt').click({ modifiers: ['ControlOrMeta'] })
  await row('inner').click({ modifiers: ['ControlOrMeta'] })
  assert.deepEqual(await selected(), ['aa-explorer/a.txt', 'aa-explorer/c.txt', 'aa-explorer/d.md', 'aa-explorer/inner'])
  // Row backgrounds transition: screenshot waits for completion.
  await delay(200)
  await page.screenshot({ path: '/tmp/sillage-explorer-selection.png' })

  // Keyboard: selection follows cursor, Shift extends it.
  await row('a.txt').click()
  await page.keyboard.press('ArrowDown')
  assert.deepEqual(await selected(), ['aa-explorer/b.txt'])
  await page.keyboard.press('Shift+ArrowDown')
  assert.deepEqual(await selected(), ['aa-explorer/b.txt', 'aa-explorer/c.txt'])
  await page.keyboard.press('Escape')
  assert.deepEqual(await selected(), [])

  // Copy two files, then paste into `inner`.
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

  // Dragging two selected files onto a directory moves both.
  await row('a.txt').click()
  await row('a copy.txt').click({ modifiers: ['ControlOrMeta'] })
  await row('a.txt').dragTo(row('inner'))
  await until(async () => (await exists(join(fixture, 'inner/a.txt'))) && (await exists(join(fixture, 'inner/a copy.txt'))), 'Drag did not move the selection')
  // L'onglet ouvert sur a.txt suit son fichier.
  const tabs = panel.locator('[data-file-tabs]')
  await tabs.locator('[aria-label="Ouvrir aa-explorer/inner/a.txt"]').waitFor()
  assert.equal(await tabs.locator('[aria-label="Ouvrir aa-explorer/a.txt"]').count(), 0)

  // Deleting selection uses one confirmation.
  await row('inner/a.txt').click()
  await row('inner/a copy.txt').click({ modifiers: ['ControlOrMeta'] })
  await page.keyboard.press('Delete')
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'))
  await dialog.getByText('Supprimer ces 2 éléments ?').waitFor()
  await dialog.getByRole('button', { name: 'Supprimer', exact: true }).click()
  await until(async () => !(await exists(join(fixture, 'inner/a.txt'))) && !(await exists(join(fixture, 'inner/a copy.txt'))), 'Delete failed')
  // Without a draft, deleted files' tabs close.
  await tabs.locator('[aria-label^="Ouvrir aa-explorer/inner/a"]').waitFor({ state: 'detached' })

  // Copy relative path and download a directory as zip.
  await row('inner').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copier le chemin relatif' }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'aa-explorer/inner')
  await row('inner').click({ button: 'right' })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Télécharger en .zip' }).click()])
  assert.equal(download.suggestedFilename(), 'inner.zip')
  const zipped = Object.keys(unzipSync(new Uint8Array(await readFile(await download.path())))).sort()
  assert.deepEqual(zipped, ['inner/', 'inner/b.txt', 'inner/c.txt', 'inner/d.md'])

  // Expanded directories survive search and collapse with one action.
  await panel.getByRole('searchbox').fill('b.txt')
  await panel.locator('[data-tree-path="aa-explorer/b.txt"]').waitFor()
  await panel.getByRole('searchbox').fill('')
  assert.equal(await row('inner').getAttribute('aria-expanded'), 'true')
  await panel.getByRole('button', { name: 'Replier tous les dossiers' }).click()
  assert.equal(await row('').getAttribute('aria-expanded'), 'false')

  // Search ranks like the palette (initials of the filename) and offers ignored loose files.
  await panel.getByRole('searchbox').fill('fcache')
  await panel.locator('[data-tree-path="ab-editor/forecast-cache.ts"]').waitFor()
  await panel.getByRole('searchbox').fill('env.local')
  await panel.locator('[data-tree-path="ab-editor/.env.local"]').waitFor()
  await panel.getByRole('searchbox').fill('')

  // A level cut at the server's limit says so, after sorting numbers by value.
  const manyRow = (path) => panel.locator(`[data-tree-path="ad-many${path ? `/${path}` : ''}"]`)
  await manyRow('').click()
  await panel.getByText('Seuls les 1 000 premiers éléments sur 1 003 sont affichés', { exact: false }).waitFor()
  assert.deepEqual(
    await panel.locator('[data-tree-path^="ad-many/"]').evaluateAll((rows) => rows.slice(0, 3).map((row) => row.dataset.treeName)),
    ['f1', 'f2', 'f3'],
  )
  // A row's … opens the tree's single menu for that row.
  await panel.getByRole('button', { name: 'Actions de f2', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Renommer' }).waitFor()
  assert.equal(await page.getByRole('menu').count(), 1)
  await page.keyboard.press('Escape')
  await manyRow('').click()

  // Typing a name prefix navigates to it.
  await row('').click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('c')
  assert.deepEqual(await selected(), ['aa-explorer/c.txt'])
  await delay(200)
  await page.screenshot({ path: '/tmp/sillage-explorer-desktop.png' })

  // Empty space below the entries has its own menu, aimed at the root. A row's right-click
  // still opens only the row's menu.
  await row('').click({ button: 'right' })
  assert.equal(await page.getByRole('menu').count(), 1)
  await page.keyboard.press('Escape')
  const background = panel.locator('[data-tree-background]')
  await background.click({ button: 'right' })
  assert.equal(await page.getByRole('menu').count(), 1)
  await delay(150)
  await page.screenshot({ path: '/tmp/sillage-explorer-background-menu.png' })
  await page.getByRole('menuitem', { name: 'Nouveau fichier à la racine' }).click()
  await panel.getByRole('textbox', { name: 'Nom' }).fill('zz-root.txt')
  await page.keyboard.press('Enter')
  await until(() => exists(join(project.workspace_path, 'zz-root.txt')), 'Background menu did not create the file at root')
  await background.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Nouveau dossier à la racine' }).click()
  await panel.getByRole('textbox', { name: 'Nom' }).fill('zz-dir')
  await page.keyboard.press('Enter')
  await until(() => exists(join(project.workspace_path, 'zz-dir')), 'Background menu did not create the folder at root')

  // Editor: saving keeps CRLF line breaks, new lines included.
  const editorRow = (path) => panel.locator(`[data-tree-path="ab-editor${path ? `/${path}` : ''}"]`)
  const editorOf = (path) => panel.locator(`[data-editor-file="ab-editor/${path}"]`)
  await editorRow('').click()
  await editorRow('crlf.txt').dblclick()
  await editorOf('crlf.txt').locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('four')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+s')
  await until(async () => (await readFile(join(editorFixture, 'crlf.txt'), 'utf8')).includes('four'), 'CRLF file was not saved')
  assert.equal(await readFile(join(editorFixture, 'crlf.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\nfour\r\n')

  // A file that is not UTF-8 opens read-only: saving would replace its bytes.
  await editorRow('latin1.txt').dblclick()
  await editorOf('latin1.txt').getByRole('note').waitFor()
  await editorOf('latin1.txt').locator('.cm-content').click()
  await page.keyboard.type('Y')
  await page.keyboard.press('ControlOrMeta+s')
  await delay(300)
  assert.equal(await editorOf('latin1.txt').locator('.cm-content').textContent(), 'caf\ufffd')
  assert.deepEqual([...await readFile(join(editorFixture, 'latin1.txt'))], [0x63, 0x61, 0x66, 0xe9, 0x0a])

  // An open file follows the disk: an agent's write appears in place, keeping the scroll
  // position, and its lines are highlighted for a moment.
  await editorRow('long.txt').dblclick()
  const longScroller = editorOf('long.txt').locator('.cm-scroller')
  await editorOf('long.txt').locator('.cm-content').waitFor()
  await longScroller.evaluate((node) => { node.scrollTop = 3000 })
  await delay(200)
  const scrolled = await longScroller.evaluate((node) => node.scrollTop)
  await writeFile(join(editorFixture, 'long.txt'), lines(300, (number) => number === 150 ? 'line 150 from the agent' : null))
  await editorOf('long.txt').getByText('line 150 from the agent').waitFor()
  assert.ok(Math.abs((await longScroller.evaluate((node) => node.scrollTop)) - scrolled) < 30, 'A reread moved the scroll position')
  assert.equal(await editorOf('long.txt').locator('.cm-externalChange').count(), 1)
  await editorOf('long.txt').getByRole('status').filter({ hasText: 'À jour' }).waitFor()

  // A draft learns about a write on disk without waiting for its save, then compares with it.
  await editorRow('live.txt').dblclick()
  await editorOf('live.txt').locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('mine ')
  await writeFile(join(editorFixture, 'live.txt'), lines(12, (number) => number === 10 ? 'line 10 from the agent' : null))
  const conflictBanner = editorOf('live.txt').getByRole('alert')
  await conflictBanner.waitFor()
  await conflictBanner.getByRole('button', { name: 'Comparer', exact: true }).click()
  await editorOf('live.txt').getByRole('note').waitFor()
  const agentChunk = editorOf('live.txt').locator('.cm-deletedChunk').filter({ hasText: 'line 10 from the agent' })
  const mineChunk = editorOf('live.txt').locator('.cm-deletedChunk').filter({ hasText: 'line 1' }).filter({ hasNotText: 'line 10' })
  await agentChunk.waitFor()
  await delay(150)
  await page.screenshot({ path: '/tmp/sillage-editor-compare.png' })
  await agentChunk.getByRole('button', { name: 'Rétablir', exact: true }).click()
  await mineChunk.getByRole('button', { name: 'Garder', exact: true }).click()
  await editorOf('live.txt').locator('.cm-deletedChunk').first().waitFor({ state: 'detached' })
  await editorOf('live.txt').getByRole('button', { name: 'Enregistrer', exact: true }).click()
  const merged = lines(12, (number) => (number === 1 ? 'mine line 1' : number === 10 ? 'line 10 from the agent' : null))
  await until(async () => (await readFile(join(editorFixture, 'live.txt'), 'utf8')) === merged, 'The comparison did not save the merged text')

  // An open file deleted on disk says so and keeps its text; it recovers when the file returns.
  const gone = editorOf('live.txt').getByText('Ce fichier n’existe plus sur le disque.')
  await rm(join(editorFixture, 'live.txt'))
  await gone.waitFor()
  await writeFile(join(editorFixture, 'live.txt'), merged)
  await gone.waitFor({ state: 'detached' })

  // A file changed deep in the tree colors its ancestors too.
  const trackedRow = (path) => panel.locator(`[data-tree-path="ac-tracked${path ? `/${path}` : ''}"]`)
  await trackedRow('').click()
  await trackedRow('deep').click()
  await trackedRow('deep/nested').click()
  await trackedRow('deep/nested/file.ts').waitFor()
  assert.equal((await trackedRow('').textContent()).trim(), 'ac-tracked')
  // Watches start a moment after a level opens: a write within it would go unseen.
  await delay(500)
  await writeFile(join(project.workspace_path, 'ac-tracked/deep/nested/file.ts'), 'export const changed = true\n')
  for (const path of ['deep/nested/file.ts', 'deep/nested', 'deep', '']) {
    await until(async () => (await trackedRow(path).textContent()).trim().endsWith('M'), `${path || 'ac-tracked'} did not turn modified`)
  }

  // A draft outlives closing the page and comes back in a new one.
  await editorRow('draft.txt').dblclick()
  await editorOf('draft.txt').locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('unsaved ')
  await editorOf('draft.txt').getByText('Brouillon conservé sur cet appareil').waitFor()
  await page.close()
  const reopened = await context.newPage()
  reopened.on('pageerror', (error) => errors.push(error.message))
  await reopened.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  const reopenedPanel = reopened.locator('[data-panel="workspace"]')
  await reopenedPanel.getByRole('button', { name: 'ab-editor/draft.txt' }).click()
  await until(
    async () => (await reopenedPanel.locator('[data-editor-file="ab-editor/draft.txt"] .cm-content').textContent().catch(() => '')) === 'unsaved draft base',
    'Draft did not survive closing the page',
  )
  assert.equal(await readFile(join(editorFixture, 'draft.txt'), 'utf8'), 'draft base\n')
  await reopened.close()

  // Touch: “Select” opens selection mode, where tapping selects.
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

  // A long press on the empty space opens the root menu, alone.
  const mobileBackground = mobilePanel.locator('[data-tree-background]')
  await mobileBackground.scrollIntoViewIfNeeded()
  const box = await mobileBackground.boundingBox()
  await mobileBackground.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: box.x + 40, clientY: box.y + 10 })
  await mobile.getByRole('menuitem', { name: 'Nouveau fichier à la racine' }).waitFor()
  assert.equal(await mobile.getByRole('menu').count(), 1)
  await mobileBackground.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true })
  await delay(150)
  await mobile.screenshot({ path: '/tmp/sillage-explorer-mobile-background.png' })
  await mobile.keyboard.press('Escape')

  // The comparison fits a phone: footer and chunk buttons stay within the screen.
  await mobilePanel.locator('[data-tree-path="ab-editor"]').tap()
  await mobilePanel.locator('[data-tree-path="ab-editor/crlf.txt"]').tap()
  const mobileEditor = mobilePanel.locator('[data-editor-file="ab-editor/crlf.txt"]')
  await mobileEditor.locator('.cm-content').tap()
  await mobile.keyboard.press('ControlOrMeta+Home')
  await mobile.keyboard.type('phone ')
  await mobileEditor.getByRole('button', { name: 'Comparer avec le disque', exact: true }).tap()
  await mobileEditor.locator('.cm-deletedChunk').getByRole('button', { name: 'Rétablir', exact: true }).waitFor()
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  for (const name of ['Rétablir', 'Garder']) {
    const box = await mobileEditor.locator('.cm-deletedChunk').getByRole('button', { name, exact: true }).boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `${name} outside the phone screen`)
    assert.ok(box.height >= 44, `${name} too small for a finger`)
  }
  await delay(150)
  await mobile.screenshot({ path: '/tmp/sillage-editor-compare-mobile.png' })

  assert.deepEqual(errors, [])
  console.log('OK : sélection multiple, clavier, copier/couper/coller, glisser, suppression groupée, zip, recherche floue avec fichiers ignorés, dossier tronqué, menu unique de l’arbre et de l’espace vide, CRLF, lecture seule hors UTF-8, fichier ouvert qui suit le disque, conflit annoncé et comparaison, couleurs des dossiers parents, brouillon durable et mode sélection au doigt.')
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
