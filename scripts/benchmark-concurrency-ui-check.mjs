import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Real UI on disposable Server and Desktop instances; benchmark requests are intercepted
// so checking the form never spends model quota. Scheduler and API have server tests.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-benchmark-'))
const shots = process.env.BENCHMARK_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-benchmark-shots-')))
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
  await writeFile(config, '[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n[agents.antigravity]\nenabled = false\n')
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
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const page = await context.newPage()
  const errors = []
  // Playwright's `serviceWorkers: 'block'` patches navigator.serviceWorker in every frame, which
  // throws inside the previews' opaque-origin sandbox. That is the harness, not the page.
  page.on('pageerror', (error) => {
    if (!/serviceWorker.*sandboxed/.test(error.message)) errors.push(error.message)
  })
  await mkdir(shots, { recursive: true })


  async function checkForm(page, base, profile) {
    let saved = null
    await page.route('**/api/benchmarks', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON()
        assert.equal(body.concurrency, 7)
        saved = { ...body, id: 'test-benchmark', variants: body.variants.map((v, i) => ({ ...v, id: String(i), label: 'Test' })), inputs: [], runs: [], createdAt: Date.now(), updatedAt: Date.now(), seriesId: null }
        return route.fulfill({ json: saved })
      }
      return route.fulfill({ json: saved ? [saved] : [] })
    })
    await page.route('**/api/benchmarks/test-benchmark/concurrency', async (route) => {
      saved.concurrency = route.request().postDataJSON().concurrency
      return route.fulfill({ json: saved })
    })
    for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport)
      await page.goto(base + '/benchmarks/new')
      const field = page.getByRole('spinbutton', { name: 'Exécutions simultanées', exact: true })
      await field.waitFor()
      assert.equal(await field.inputValue(), '1')
      await page.getByRole('textbox', { name: 'Nom', exact: true }).fill('Parallélisme configurable')
      await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Test')
      await page.locator('[data-benchmark-variant]').first().waitFor()
      for (const invalid of ['0', '1.5', '61', '']) {
        await field.fill(invalid)
        assert.ok(await page.getByRole('button', { name: 'Lancer le benchmark', exact: true }).isDisabled())
      }
      await field.fill('7')
      assert.ok(await page.getByRole('button', { name: 'Lancer le benchmark', exact: true }).isEnabled())
      await field.scrollIntoViewIfNeeded()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: join(shots, profile + '-' + size + '-form.png') })
      await page.getByRole('button', { name: 'Lancer le benchmark', exact: true }).click()
      await page.getByRole('heading', { name: 'Parallélisme configurable', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Modifier les exécutions simultanées', exact: true }).click()
      const dialog = page.getByRole('dialog')
      assert.equal(await dialog.getByRole('spinbutton').inputValue(), '7')
      await dialog.getByRole('spinbutton').fill('2')
      await page.screenshot({ path: join(shots, profile + '-' + size + '-edit.png') })
      await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: 'Modifier les exécutions simultanées', exact: true }).click()
      assert.equal(await dialog.getByRole('spinbutton').inputValue(), '2')
      await page.keyboard.press('Escape')
    }
  }
  await checkForm(page, base, 'server')
  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...env, NODE_ENV: 'production' })
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)
  const desktop = run(['--import', 'tsx', 'src/main.ts'], serverDir, {
    ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3',
    SILLAGE_PORT: String(await freePort()), SILLAGE_DATA_DIR: join(data, 'desktop-data'), SILLAGE_WEB_ROOT: webDist,
  }, ['pipe', 'pipe', 'pipe', 'pipe'])
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    desktop.stdio[3].setEncoding('utf8')
    desktop.stdio[3].on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end !== -1) resolve(JSON.parse(buffer.slice(0, end)))
    })
    desktop.once('exit', () => reject(new Error(desktop.diagnostics)))
  })
  const desktopOrigin = 'http://127.0.0.1:' + handshake.port
  const desktopContext = await browser.newContext({ serviceWorkers: 'block' })
  await desktopContext.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await desktopContext.addCookies([{ name: 'sillage_session', value: handshake.session, url: desktopOrigin }])
  const settings = await desktopContext.request.patch(desktopOrigin + '/api/me/settings', { data: { onboarding: { pending: false } } })
  assert.ok(settings.ok(), await settings.text())
  const desk = await desktopContext.newPage()
  desk.on('pageerror', (error) => errors.push(error.message))
  await checkForm(desk, desktopOrigin, 'desktop')
  assert.deepEqual(errors, [])
  console.log('benchmark-concurrency-ui-check: ok; screenshots: ' + shots)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
