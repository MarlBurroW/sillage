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

// The interface tour on the real application: it waits for a conversation, walks every step
// on a wide screen and on a phone with each bubble pointing at its element, ends or is
// skipped once, and replays from About. Run it after moving anything a step points at.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-tour-check-'))
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
  await writeFile(config, '')
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  delete env.NODE_ENV
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const errors = []
  const open = async (viewport) => {
    const context = await browser.newContext({ ...viewport, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    return context
  }
  const headers = { origin: base }
  const account = { username: 'nico', displayName: 'Nico', password: 'correct horse battery' }

  // An account that just finished the first-run tour, with one project to open.
  const wide = await open({ viewport: { width: 1440, height: 900 } })
  const api = wide.request
  assert.ok((await api.post(`${base}/api/auth/setup`, { headers, data: account })).ok())
  const arm = async (request = api) => {
    const settings = await (await request.get(`${base}/api/me/settings`)).json()
    const patched = await request.patch(`${base}/api/me/settings`, { headers, data: { onboarding: { ...settings.onboarding, pending: false, interfaceTourPending: true } } })
    assert.ok(patched.ok(), await patched.text())
  }
  const due = async (request = api) => (await (await request.get(`${base}/api/me/settings`)).json()).onboarding.interfaceTourPending
  await arm()
  const created = await api.post(`${base}/api/projects/sample`, { headers, data: { parentDir: join(data, 'projects') } })
  assert.ok(created.ok(), await created.text())
  const draft = `${base}/p/${(await created.json()).id}/c/new`

  /** Walks the tour: each bubble names its step, stays in the window and frames its element. */
  const walk = async (page, expected) => {
    const bubble = page.getByRole('dialog').filter({ has: page.locator('[data-tour-next]') })
    const seen = []
    for (let i = 0; i < expected.length; i++) {
      await page.locator(`[data-tour-step="${expected[i]}"]`).waitFor({ timeout: 30000 })
      const id = await bubble.getAttribute('data-tour-step')
      seen.push(id)
      await bubble.getByText(`${i + 1} sur ${expected.length}`).waitFor()
      // The frame settles on its element, then the bubble must be whole inside the window.
      await page.waitForFunction((step) => {
        const frame = document.querySelector('[data-interface-tour] [aria-hidden]')?.getBoundingClientRect()
        const anchor = [...document.querySelectorAll(`[data-tour="${step}"]`)].map((node) => node.getBoundingClientRect()).find((rect) => rect.width > 0 && rect.right > 0)
        const card = document.querySelector('[data-tour-step]')?.getBoundingClientRect()
        if (!frame || !anchor || !card) return false
        const framed = Math.abs(frame.left - (anchor.left - 6)) < 2 && Math.abs(frame.top - (anchor.top - 6)) < 2
        const inside = card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight
        return framed && inside
      }, id, { timeout: 10000 })
      await page.screenshot({ path: `/tmp/sillage-tour-${page.viewportSize().width}-${i + 1}-${id}.png` })
      await page.locator('[data-tour-next]').click()
    }
    assert.deepEqual(seen, expected)
    await page.locator('[data-interface-tour]').waitFor({ state: 'detached' })
  }

  const page = await wide.newPage()
  page.on('pageerror', (error) => errors.push(error.message))

  // No conversation on screen: the tour waits instead of describing what is not there.
  await page.goto(`${base}/settings/apparence`)
  await page.getByRole('heading', { name: 'Apparence' }).first().waitFor()
  await delay(1500)
  assert.equal(await page.locator('[data-interface-tour]').count(), 0, 'pas de tour hors d’une conversation')

  // First conversation: every step, in order, then the flag is cleared on the account.
  await page.goto(draft)
  await walk(page, ['rail', 'column', 'agent', 'composer', 'panel', 'palette'])
  assert.equal(await due(), false)
  await page.reload()
  await page.getByPlaceholder(/^Écris ton message/).waitFor()
  await delay(1000)
  assert.equal(await page.locator('[data-interface-tour]').count(), 0, 'vu une fois')

  // Skipping takes one key, and the page behind is not clickable meanwhile.
  await arm()
  await page.reload()
  await page.locator('[data-tour-step="rail"]').waitFor({ timeout: 30000 })
  await page.mouse.click(700, 560)
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BUTTON', 'le clic n’atteint pas la page')
  await page.keyboard.press('ArrowRight')
  await page.locator('[data-tour-step="column"]').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[data-interface-tour]').waitFor({ state: 'detached' })
  assert.equal(await due(), false)

  // Replay from About: a personal conversation opens, with the tour over it.
  await page.goto(`${base}/settings/a-propos`)
  await page.getByRole('button', { name: 'Revoir le tour de l’interface' }).click()
  await page.waitForURL(/\/discussions\/new$/)
  await page.locator('[data-tour-step="rail"]').waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: 'Passer le tour' }).click()
  await page.locator('[data-interface-tour]').waitFor({ state: 'detached' })

  // Phone: the menu button stands for the rail and the column, and nothing overflows.
  await arm()
  const phoneContext = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  assert.ok((await phoneContext.request.post(`${base}/api/auth/login`, { headers, data: { username: account.username, password: account.password } })).ok())
  const phone = await phoneContext.newPage()
  phone.on('pageerror', (error) => errors.push(error.message))
  await phone.goto(draft)
  await walk(phone, ['menu', 'agent', 'composer', 'panel'])
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Pas de débordement au téléphone')
  assert.equal(await due(), false)

  assert.deepEqual(errors, [])
  console.log('OK : tour de l’interface en grand écran et au téléphone, passage, rejeu depuis À propos.')
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
