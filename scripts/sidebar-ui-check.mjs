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
  await context.addInitScript((origin) => {
    // Browser PDF viewer does not expose application storage.
    if (window === window.top && location.origin === origin) { localStorage.setItem('sillage.locale', 'fr'); localStorage.setItem('sillage.theme', 'dark') }
  }, new URL(base).origin)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(12000)
  // Exercise the browser login and its cookie before entering a known conversation.
  await page.goto(base)
  await page.getByRole('textbox', { name: "Nom d'utilisateur", exact: true }).fill('alex')
  await page.getByRole('textbox', { name: 'Mot de passe', exact: true }).fill('sillage-demo')
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  await page.waitForURL(/\/p\/[^/]+\/c\/[^/]+$/)
  assert.equal(await page.evaluate(() => fetch('/api/auth/me').then(response => response.status)), 200)
  const projects = await (await context.request.get(`${base}/api/projects`)).json()
  const project = projects.find((entry) => entry.name === 'Nimbus')
  const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
  const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
  // Demo titles are pinned by their author; allow this fixture to exercise agent naming first.
  const unpin = run(['--input-type=module', '-e', "import Database from 'better-sqlite3'; const db = new Database(process.argv[1]); db.prepare('UPDATE conversations SET title_set_by_user = 0 WHERE id = ?').run(process.argv[2]); db.close()", join(data, 'data/sillage.db'), hero.id], serverDir, env)
  assert.equal((await once(unpin, 'exit'))[0], 0, unpin.diagnostics)
  const agentRename = async title => {
    const child = run(['src/mcp/sillage-mcp.mjs'], serverDir, { ...env, SILLAGE_MCP_DB: join(data, 'data/sillage.db'), SILLAGE_MCP_PROJECT: project.id, SILLAGE_MCP_CONVERSATION: hero.id })
    try {
      const response = new Promise((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => reject(new Error(`MCP timeout: ${child.diagnostics}`)), 20000)
        child.stdout.on('data', chunk => {
          output += chunk.toString()
          if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.split('\n')[0]).result) }
        })
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(child.diagnostics)) })
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rename_session', arguments: { title } } }) + '\n')
      return await response
    } finally { child.kill() }
  }
  const shots = process.env.SILLAGE_UI_SHOTS ?? await mkdtemp(join(tmpdir(), 'sillage-sidebar-shots-'))
  await mkdir(shots, { recursive: true })
  const states = ['dirty', 'unmerged', 'merged', 'missing', 'unknown']
  const fixtures = Array.from({ length: 30 }, (_, i) => ({ ...hero,
    id: `fixture-${i}`, title: `Session de travail ${i + 1}`,
    agent: ['codex', 'claude', 'opencode', 'grok'][i % 4],
    favorite: false, archivedAt: null, status: 'cold', worktreeId: `tree-${i}`,
  }))
  await context.route('**/api/conversations', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ json: [...await response.json(), ...fixtures] })
  })
  await context.route(`**/api/projects/${project.id}/worktrees/status`, route => route.fulfill({ json: {
    base: 'main', fresh: true, computedAt: Date.now(), worktrees: fixtures.slice(0, 4).map((entry, i) => ({
      id: entry.worktreeId, name: `design/session-${i}`, path: `/tmp/worktrees/session-${i}`,
      branch: `design/session-${i}`, state: states[i], ahead: 2, behind: 0, modified: 3,
      untracked: 0, conflicts: 0, lastCommitAt: Date.now(), lastEditAt: Date.now(),
      conversations: [{ id: entry.id, link: 'worktree' }],
    })),
  } }))
  await page.goto(`${base}/p/${project.id}/c/${hero.id}`)
  const sidebar = page.locator('.sidebar-layout:visible')
  const switcher = sidebar.getByRole('button', { name: 'Changer de projet', exact: true })
  await switcher.waitFor()
  await sidebar.locator(`[data-sidebar-session="${hero.id}"]`).waitFor()
  await page.screenshot({ path: join(shots, 'desktop.png') })
  const row = id => sidebar.locator(`[data-sidebar-session="${id}"]`)
  const details = id => row(id).locator('[data-session-details]')
  assert.equal((await agentRename('Prévisions météo hors ligne')).isError, undefined)
  await row(hero.id).getByText('Prévisions météo hors ligne', { exact: true }).waitFor()
  await agentRename(hero.title)
  await row(hero.id).getByText(hero.title, { exact: true }).waitFor()
  await sidebar.getByRole('button', { name: /Voir les .* sessions/ }).click()
  await row('fixture-29').waitFor()
  const before = await switcher.boundingBox()
  await sidebar.locator('[data-sidebar-session-scroll]').evaluate(el => { el.scrollTop = el.scrollHeight })
  assert.deepEqual(await switcher.boundingBox(), before)
  await sidebar.locator('[data-sidebar-session-scroll]').evaluate(el => { el.scrollTop = 0 })

  // Hover and keyboard reveal full metadata. Git is identical in the list and preview.
  for (const [i, state] of states.entries()) {
    const id = `fixture-${i}`
    const button = details(id)
    await button.scrollIntoViewIfNeeded()
    const icon = await button.locator('svg').getAttribute('class')
    const location = page.url()
    await button.click()
    const preview = page.locator('.session-preview-popover')
    await preview.waitFor()
    await preview.locator(`[data-preview-git="${state}"]`).waitFor()
    assert.equal(await preview.locator('[data-preview-git] svg').getAttribute('class'), icon)
    assert.equal(page.url(), location)
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'detached' })
    await page.waitForFunction(id => document.activeElement?.getAttribute('data-session-details') === id, id)
  }
  const firstLink = row('fixture-0').locator('.sidebar-session-link')
  await switcher.focus()
  await page.mouse.move(800, 20)
  await firstLink.hover()
  await page.getByRole('tooltip').filter({ hasText: 'design/session-0' }).waitFor()
  await page.screenshot({ path: join(shots, 'tooltip.png') })
  await switcher.hover()
  await page.keyboard.press('Escape')
  await page.getByRole('tooltip').waitFor({ state: 'detached' })
  await firstLink.focus()
  await page.getByRole('tooltip').filter({ hasText: 'design/session-0' }).waitFor()
  await page.keyboard.press('Escape')
  await sidebar.getByRole('button', { name: 'Filtrer les sessions' }).click()
  await sidebar.getByRole('searchbox').fill('design/session-1')
  await row('fixture-1').waitFor()
  assert.equal(await sidebar.locator('[data-sidebar-session]').count(), 1)
  await sidebar.getByRole('searchbox').fill('introuvablexyz')
  await sidebar.getByRole('status').filter({ hasText: 'Aucune session ne correspond' }).waitFor()
  await sidebar.getByRole('button', { name: 'Filtrer les sessions' }).click()

  // Keep the existing project switcher and activity dialogs.
  await switcher.click()
  const dialog = page.getByRole('dialog', { name: 'Changer de projet' })
  await dialog.getByRole('textbox', { name: 'Rechercher un projet…' }).fill('atlas')
  await dialog.getByRole('button', { name: 'Atlas API', exact: true }).click()
  await switcher.filter({ hasText: 'Atlas API' }).waitFor()
  await switcher.click()
  await dialog.getByRole('button', { name: 'Nimbus', exact: true }).click()
  await page.waitForURL(`**/c/${hero.id}`)
  await sidebar.locator('.sidebar-activity-main').click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer', exact: true }).click()
  await row(hero.id).hover()
  await row(hero.id).locator('.sidebar-session-menu').click()
  await page.getByRole('menuitem', { name: /Renommer/ }).waitFor()
  await page.getByRole('menuitem', { name: /Archiver/ }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('menu').waitFor({ state: 'detached' })

  await row(hero.id).locator('.sidebar-session-menu').click()
  await page.getByRole('menuitem', { name: 'Renommer', exact: true }).click()
  const rename = sidebar.getByRole('textbox')
  await rename.fill('Cache hors ligne')
  await rename.press('Enter')
  await row(hero.id).getByText('Cache hors ligne', { exact: true }).waitFor()
  assert.match((await agentRename('Remplacement par le LLM')).content[0].text, /choisi par l'utilisateur/)
  const protectedSession = await (await context.request.get(`${base}/api/conversations/${hero.id}`)).json()
  assert.equal(protectedSession.title, 'Cache hors ligne')
  await row(hero.id).locator('.sidebar-session-menu').click()
  await page.getByRole('menuitem', { name: 'Mettre en favori', exact: true }).click()
  await sidebar.locator('.sidebar-global-link').filter({ hasText: 'Favoris' }).click()
  await sidebar.locator('#sidebar-favorites').getByText('Cache hors ligne', { exact: true }).waitFor()
  await sidebar.locator('.sidebar-global-link').filter({ hasText: 'Favoris' }).click()
  await row(hero.id).locator('.sidebar-session-menu').click()
  await page.getByRole('menuitem', { name: 'Retirer des favoris', exact: true }).click()
  await row(hero.id).locator('.sidebar-session-menu').click()
  await page.getByRole('menuitem', { name: 'Renommer', exact: true }).click()
  await rename.fill(hero.title)
  await rename.press('Enter')
  await row(hero.id).getByText(hero.title, { exact: true }).waitFor()
  await switcher.click()
  await dialog.getByRole('button', { name: 'Tous les projets', exact: true }).click()
  await sidebar.getByRole('link', { name: 'Atlas API', exact: true }).waitFor()
  await switcher.click()
  await dialog.getByRole('button', { name: 'Nimbus', exact: true }).click()

  for (const width of [200, 264, 320, 480]) {
    await page.evaluate(width => document.documentElement.style.setProperty('--sidebar-desktop-width', `${width}px`), width)
    assert.ok(await sidebar.evaluate(el => el.scrollWidth <= el.clientWidth), `Sidebar fits ${width}px`)
    await page.screenshot({ path: join(shots, `width-${width}.png`) })
  }
  // Navigation does not reopen the project panel.
  await page.evaluate(() => localStorage.setItem('sillage.panelOpen', '0'))
  await page.reload()
  const other = conversations.find(entry => entry.id !== hero.id && !entry.archivedAt && !entry.scheduleId)
  await row(other.id).locator('.sidebar-session-link').click()
  await page.waitForURL(`**/c/${other.id}`)
  assert.equal(await page.locator('[data-panel="workspace"]').count(), 0)

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block', storageState: await context.storageState() })
  const phone = await mobile.newPage()
  phone.setDefaultTimeout(12000)
  phone.on('pageerror', error => errors.push(error.message))
  await phone.goto(`${base}/p/${project.id}/c/${hero.id}`)
  await phone.locator('[data-navigation-trigger]').click()
  const drawer = phone.locator('.sidebar-layout:visible')
  await drawer.locator(`[data-session-details="${hero.id}"]`).tap()
  const preview = phone.locator('.session-preview-popover')
  await preview.waitFor()
  await phone.screenshot({ path: join(shots, 'mobile-preview.png') })
  const box = await preview.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844)
  await phone.screenshot({ path: join(shots, 'mobile-preview.png') })
  await phone.keyboard.press('Escape')
  await preview.waitFor({ state: 'detached' })
  assert.ok(await drawer.isVisible(), 'Closing details must leave the navigation open')
  await drawer.locator(`[data-sidebar-session="${hero.id}"] .sidebar-session-menu`).tap()
  await phone.getByRole('menuitem', { name: /Renommer/ }).waitFor()
  await phone.keyboard.press('Escape')
  await phone.screenshot({ path: join(shots, 'mobile.png') })
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.getByRole('menu').waitFor({ state: 'detached' })
  await phone.setViewportSize({ width: 320, height: 568 })
  await drawer.locator(`[data-session-details="${hero.id}"]`).tap()
  await preview.waitFor()
  await phone.screenshot({ path: join(shots, 'mobile-small.png') })
  const small = await preview.boundingBox()
  assert.ok(small.x >= 0 && small.x + small.width <= 320 && small.y >= 0 && small.y + small.height <= 568)
  await preview.getByRole('button', { name: 'Fermer', exact: true }).tap()
  assert.ok(await drawer.locator('.sidebar-utilities').isVisible())
  // Reopen the disposable database with the Desktop launcher contract. No Electron required.
  await mobile.close()
  await context.close()
  const stopped = once(server, 'exit')
  server.kill('SIGTERM')
  await stopped
  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...env, NODE_ENV: 'production' })
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)
  const desktopPort = await freePort()
  const desktop = run(['--import', 'tsx', 'src/main.ts'], serverDir, {
    ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3',
    SILLAGE_PORT: String(desktopPort), SILLAGE_WEB_ROOT: webDist,
  }, ['pipe', 'pipe', 'pipe', 'pipe'])
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    desktop.stdio[3].setEncoding('utf8')
    desktop.stdio[3].on('data', chunk => {
      buffer += chunk
      if (buffer.includes('\n')) resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
    })
    desktop.once('exit', () => reject(new Error(desktop.diagnostics)))
  })
  const desktopBase = `http://127.0.0.1:${handshake.port}`
  const local = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await local.addCookies([{ name: 'sillage_session', value: handshake.session, url: desktopBase }])
  await local.addInitScript(() => { localStorage.setItem('sillage.locale', 'fr'); localStorage.setItem('sillage.theme', 'dark') })
  const desk = await local.newPage()
  desk.on('pageerror', error => errors.push(error.message))
  await desk.goto(`${desktopBase}/p/${project.id}/c/${hero.id}`)
  const localSidebar = desk.locator('.sidebar-layout')
  await localSidebar.locator(`[data-sidebar-session="${hero.id}"]`).waitFor()
  assert.equal(await localSidebar.getByRole('button', { name: 'Menu du compte' }).count(), 0)
  await localSidebar.locator(`[data-session-details="${hero.id}"]`).click()
  await desk.locator('.session-preview-popover').waitFor()
  await desk.keyboard.press('Escape')
  await desk.screenshot({ path: join(shots, 'desktop-edition.png') })
  assert.deepEqual(errors, [])
  console.log(`Sidebar verified: symbols, rich previews, keyboard, touch, filtering, existing dialogs, panel navigation. Screenshots: ${shots}`)
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
