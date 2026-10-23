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

// Resizing either sidebar must not make the composer alternate layouts until React crashes.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-sidebar-resize-check-'))
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
  for (let i = 0; i < 300; i++) {
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
    GIT_AUTHOR_NAME: 'Alex Demo',
    GIT_AUTHOR_EMAIL: 'alex@example.test',
    GIT_COMMITTER_NAME: 'Alex Demo',
    GIT_COMMITTER_EMAIL: 'alex@example.test',
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

  const session = async (viewport, mobile) => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
    const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
    const rooted = conversations.find((entry) => entry.title === 'Refactor settings storage')
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    return { context, page, errors, project, hero, rooted }
  }

  const { page, context, errors, project, hero } = await session({ width: 1440, height: 900 }, false)
  await page.goto(`${base}/p/${project.id}/c/${hero.id}`)
  await page.locator('textarea').waitFor()
  await page.waitForTimeout(1000)
  const threshold = await page.evaluate(() => {
    const bar = document.querySelector('form textarea').parentElement.querySelector('div.flex.items-center.gap-1')
    const prefs = bar.querySelector('.min-w-0')
    const lead = bar.querySelector('.order-1')
    const trail = bar.querySelector('.order-3')
    // Simulate a longer model label so wrapping happens above the compact toolbar breakpoint.
    prefs.firstElementChild.style.minWidth = `${prefs.firstElementChild.offsetWidth + 160}px`
    const natural = [...prefs.children].reduce((sum, chip) => sum + chip.offsetWidth, 0) + 4 * Math.max(0, prefs.children.length - 1)
    const threshold = natural + lead.offsetWidth + trail.offsetWidth + 8
    bar.style.width = `${threshold - 4}px`
    return threshold
  })
  await page.waitForTimeout(500)
  assert.ok(threshold > 480, 'Exercise wrapping above the compact breakpoint')
  // Cross the exact threshold repeatedly in both directions, including the former oscillation band.
  for (const offset of [20, -1, -4, -8, -20, 0, 20]) {
    await page.evaluate(width => {
      document.querySelector('form textarea').parentElement.querySelector('div.flex.items-center.gap-1').style.width = `${width}px`
    }, threshold + offset)
    await page.waitForTimeout(80)
    assert.deepEqual(errors, [])
  }
  await page.evaluate(() => document.querySelector('form textarea').parentElement.querySelector('div.flex.items-center.gap-1').style.removeProperty('width'))
  const drag = async (name, xs) => {
    const handle = page.getByRole('separator', { name, exact: true })
    const bounds = await handle.boundingBox()
    assert.ok(bounds)
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    for (const x of xs) await page.mouse.move(x, bounds.y + bounds.height / 2, { steps: 30 })
    await page.mouse.up()
    assert.deepEqual(errors, [])
    assert.ok(await page.locator('textarea').count())
  }
  await drag('Largeur de la navigation', [480, 200, 400, 240])
  await page.locator('header').getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
  await page.waitForTimeout(300)
  await drag('Largeur du panneau', [700, 1100, 900, 1200])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-panel="workspace"]').getByRole('button', { name: 'Fermer le panneau', exact: true }).click()
  await page.waitForTimeout(300)
  await page.locator('textarea').waitFor({ state: 'visible' })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  console.log('Composer wrapping, both resize handles, and phone layout verified')
  assert.deepEqual(errors, [])
  assert.ok(await page.locator('textarea').count())
  await context.close()
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await delay(200)
  await rm(data, { recursive: true, force: true })
}
