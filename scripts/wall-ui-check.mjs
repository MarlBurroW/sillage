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

// Session wall on real components, API and seeded threads; statuses come from a scripted socket.
// Set WALL_SHOTS to keep the screenshots.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-wall-check-'))
const shots = process.env.WALL_SHOTS ?? join(data, 'screenshots')
const processes = []
let browser
let current

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
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

try {
  await mkdir(shots, { recursive: true })
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
  const context = await browser.newContext({ viewport: { width: 1480, height: 920 }, locale: 'fr-FR', colorScheme: 'dark', serviceWorkers: 'block' })
  await context.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())

  // Real seeded conversations, so tiles load real threads; only their state is scripted.
  const seeded = await (await context.request.get(`${base}/api/conversations`)).json()
  assert.ok(seeded.length >= 4, 'the demo seeds enough conversations')
  const now = Date.now()
  const states = [
    { status: 'running', unread: true, ago: 0 },
    { status: 'awaiting_input', unread: true, ago: 2 },
    { status: 'error', unread: true, ago: 12 },
    { status: 'running', unread: false, ago: 0 },
    { status: 'idle', unread: true, ago: 20 },
    { status: 'idle', unread: false, ago: 55 },
    { status: 'idle', unread: false, ago: 240 },
  ]
  const fixtures = seeded.map((conversation, index) => {
    const state = states[index] ?? { status: 'idle', unread: false, ago: 600 + index }
    return {
      ...conversation, archivedAt: null, status: state.status,
      lastNotableSeq: Math.max(conversation.lastSeq, 1), lastReadSeq: state.unread ? 0 : Math.max(conversation.lastSeq, 1),
      updatedAt: now - state.ago * 60_000,
    }
  })
  const byStatus = (status) => fixtures.filter((entry) => entry.status === status)

  const page = await context.newPage()
  current = page
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/conversations', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return route.fulfill({ json: fixtures })
  })
  let socket
  await page.routeWebSocket('**/api/ws', (ws) => {
    socket = ws
    ws.onMessage((raw) => { if (JSON.parse(String(raw)).t === 'ping') ws.send(JSON.stringify({ t: 'pong' })) })
  })
  const pushStatus = (conversation, status) => socket.send(JSON.stringify({
    t: 'status', conversationId: conversation.id, status, background: 0, warm: true, loops: 0,
    lastNotableSeq: conversation.lastNotableSeq, metrics: conversation.metrics,
  }))
  const tiles = () => page.locator('article.wall-tile')
  // The query lives in the URL, updated after the click: wait for it rather than read at once.
  const expectQuery = (value) => page.waitForFunction((expected) => document.querySelector('.wall-query-input')?.value === expected, value)
  const queryField = page.getByRole('combobox', { name: 'Requête de sessions' }).or(page.getByLabel('Requête de sessions'))

  // Default view: sessions that need the user, waiting or failed.
  await page.goto(`${base}/wall`)
  const tabs = page.getByRole('tablist', { name: 'Vues enregistrées' })
  await tabs.getByRole('tab', { name: /À débloquer/ }).waitFor()
  for (const name of ['À débloquer', 'En cours', 'Non lues', 'Récentes']) await tabs.getByRole('tab', { name: new RegExp(name) }).waitFor()
  await page.waitForFunction((count) => document.querySelectorAll('article.wall-tile').length === count, byStatus('awaiting_input').length + byStatus('error').length)
  assert.equal(await queryField.inputValue(), 'is:attention')
  await page.locator('.wall-tile .wall-tile-thread').first().locator('[data-seq], .sg-tool').first().waitFor({ timeout: 15_000 })
  await page.screenshot({ path: join(shots, 'wall-attention.png') })

  // Buttons only rewrite the text: running joins the state token, unread adds its own.
  await page.getByRole('toolbar', { name: 'Filtres' }).getByRole('button', { name: 'En cours', exact: true }).click()
  await expectQuery('is:attention,running')
  await page.getByRole('toolbar', { name: 'Filtres' }).getByRole('button', { name: 'Non lues', exact: true }).click()
  await expectQuery('is:attention,running is:unread')
  assert.equal(await tiles().count(), fixtures.filter((entry) => ['running', 'awaiting_input', 'error'].includes(entry.status) && entry.lastReadSeq === 0).length)
  await page.getByRole('button', { name: 'Rétablir' }).waitFor()

  // Typed query with a project menu, then an invalid token that is underlined and ignored.
  await queryField.fill('limit:2')
  await page.waitForFunction(() => document.querySelectorAll('article.wall-tile').length === 2)
  await queryField.fill('is:bogus limit:2')
  await page.locator('.wall-query-invalid').waitFor()
  await page.getByText('Ignoré, valeur invalide : is:bogus').waitFor()
  assert.equal(await tiles().count(), 2)
  // Autocomplete follows typing.
  await queryField.fill('')
  await queryField.pressSequentially('wor')
  await page.getByRole('option', { name: /worktree:/ }).waitFor()
  await queryField.press('Enter')
  await expectQuery('worktree:')
  await queryField.press('Escape')

  // A view saved from the query comes back from the account settings.
  await queryField.fill('active:30m sort:activity')
  await page.getByRole('button', { name: 'Nouvelle vue depuis cette requête' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nouvelle vue' })
  await dialog.getByLabel('Nom').fill('Revue du matin')
  await dialog.getByRole('button', { name: 'Créer la vue' }).click()
  await tabs.getByRole('tab', { name: /Revue du matin/, selected: true }).waitFor()
  const settings = await (await context.request.get(`${base}/api/me/settings`)).json()
  assert.ok(settings.sessionViews.some((view) => view.name === 'Revue du matin' && view.query === 'active:30m sort:activity'))
  await page.screenshot({ path: join(shots, 'wall-saved-view.png') })

  // Saved views are reachable from the command palette and open their own tab.
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Rechercher', exact: true })
  await palette.getByRole('combobox').fill('mur non lues')
  await palette.getByRole('option', { name: /Mur : Non lues/ }).first().click()
  await tabs.getByRole('tab', { name: /Non lues/, selected: true }).waitFor()

  // A running session that finishes while unread keeps its slot, marked out of view.
  await tabs.getByRole('tab', { name: /En cours/ }).click()
  const finishing = byStatus('running').find((entry) => entry.lastReadSeq === 0)
  // The new view replaces the previous one's tiles before anything else happens.
  await page.waitForFunction((count) => document.querySelectorAll('article.wall-tile').length === count, byStatus('running').length)
  pushStatus(finishing, 'idle')
  const awayTile = page.locator(`article[data-conversation-id="${finishing.id}"]`)
  await awayTile.locator('.wall-tile-away-tag').waitFor()
  await page.getByText(/1 hors vue/).waitFor()
  await page.screenshot({ path: join(shots, 'wall-away.png') })

  // Keyboard: 1 focuses the first tile and opens its composer; Escape leaves it.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('1')
  const composer = page.locator('.wall-tile-focused .wall-tile-composer input')
  await composer.waitFor()
  assert.equal(await composer.inputValue(), '', 'the shortcut digit does not land in the composer')
  await page.screenshot({ path: join(shots, 'wall-focused.png') })
  // Reading the focused tile was enough: once left, the finished session goes away.
  await page.keyboard.press('Escape')
  await page.locator('.wall-tile-focused').waitFor({ state: 'detached' })
  await page.waitForFunction((id) => !document.querySelector(`article[data-conversation-id="${id}"]`), finishing.id, { timeout: 10_000 })

  // Light theme and phone width.
  // The account's appearance wins over the browser copy.
  const light = await context.request.patch(`${base}/api/me/settings`, { data: { appearance: { theme: 'light', syntax: null, values: {} } } })
  assert.ok(light.ok())
  await page.evaluate(() => localStorage.setItem('sillage.theme', 'light'))
  await page.goto(`${base}/wall?view=preset-unread`)
  await page.locator('article.wall-tile').first().waitFor()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' || document.documentElement.classList.contains('light') || getComputedStyle(document.documentElement).colorScheme.includes('light'), null, { timeout: 5000 }).catch(() => {})
  await page.screenshot({ path: join(shots, 'wall-light.png') })
  await context.request.patch(`${base}/api/me/settings`, { data: { appearance: { theme: 'dark', syntax: null, values: {} } } })
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR', colorScheme: 'dark', serviceWorkers: 'block' })
  await phone.addInitScript((origin) => { if (location.origin === origin) localStorage.setItem('sillage.locale', 'fr') }, new URL(base).origin)
  await phone.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const mobile = await phone.newPage()
  mobile.on('pageerror', (error) => errors.push(`phone: ${error.message}`))
  await mobile.route('**/api/conversations', async (route) => route.request().method() === 'GET' ? route.fulfill({ json: fixtures }) : route.continue())
  await mobile.goto(`${base}/wall`)
  await mobile.locator('article.wall-tile').first().waitFor()
  const columns = await mobile.locator('.wall-grid').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length)
  assert.equal(columns, 1)
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling on phones')
  await mobile.screenshot({ path: join(shots, 'wall-phone.png') })

  assert.deepEqual(errors, [])
  console.log(`Wall check passed. Screenshots in ${shots}`)
} catch (error) {
  await current?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
