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

// A benchmark run blocked on a permission must be visible wherever the user is: in Activity, on
// the rail, in the benchmark list and at the top of its page. Disposable Server and Desktop
// instances; the benchmark list and the status socket are stubbed, so no model runs.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-benchmark-waiting-'))
const shots = process.env.BENCHMARK_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-benchmark-waiting-shots-')))
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

const variants = [
  { id: 'v1', label: 'opus · medium', config: { agent: 'claude', model: 'opus', effort: 'medium' } },
  { id: 'v2', label: 'fable · medium', config: { agent: 'claude', model: 'fable', effort: 'medium' } },
  { id: 'v3', label: 'sonnet · medium', config: { agent: 'claude', model: 'sonnet', effort: 'medium' } },
]
const metrics = (durationMs, waitingMs) => ({
  version: 3, durationMs, elapsedMs: durationMs + waitingMs, waitingMs, firstTextMs: 5000,
  inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1,
  toolCalls: 2, toolErrors: 0, toolDurationMs: 30, assistantMessages: 2, outputChars: 400, contextTokens: 3000,
  model: 'claude', toolsByName: { Bash: 2 },
})
const run_ = (id, variantId, status, extra = {}) => ({
  id, variantId, repetition: 1, status, conversationId: `conv-${id}`, startedAt: Date.now() - 60_000, finishedAt: null,
  cliVersion: 'test', error: null, metrics: null, response: null, check: null, files: [], previewToken: null,
  rating: null, ratingNote: null, followUps: [], ...extra,
})
const benchmark = {
  id: 'transformer', name: 'Transformer', prompt: 'Une voiture qui se transforme en robot', variants,
  repetitions: 1, concurrency: 3, maxDurationMinutes: 60, inputs: [], checkScript: null, checkTimeoutSeconds: 30,
  seriesId: null, createdAt: Date.now(), updatedAt: Date.now(),
  runs: [
    run_('opus', 'v1', 'running'),
    run_('fable', 'v2', 'running'),
    run_('sonnet', 'v3', 'succeeded', { finishedAt: Date.now(), metrics: metrics(1_226_000, 0) }),
  ],
}

/** Stubs the list and the socket; returns a function that pushes one run's live status. */
async function stub(page) {
  await page.route('**/api/benchmarks', (route) => route.fulfill({ json: [benchmark] }))
  // No followed session: whatever Activity shows waiting comes from the benchmark.
  await page.route('**/api/conversations', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()))
  let socket
  let open
  const opened = new Promise((resolve) => { open = resolve })
  // Registered before navigation, or the page reaches the real socket first.
  await page.routeWebSocket('**/api/ws', (ws) => {
    socket = ws
    ws.onMessage((raw) => { if (JSON.parse(String(raw)).t === 'ping') ws.send(JSON.stringify({ t: 'pong' })) })
    open()
  })
  return async (runId, status) => {
    await Promise.race([opened, delay(15_000).then(() => { throw new Error('The page never opened its socket.') })])
    socket.send(JSON.stringify({ t: 'status', conversationId: `conv-${runId}`, status, warm: true, background: 0, loops: 0, lastNotableSeq: 1,
      metrics: { turnCount: 1, journalBytes: 100, model: null, context: null } }))
  }
}

async function check(page, base, profile, phone) {
  const push = await stub(page)
  await page.goto(`${base}/benchmarks/transformer`)
  await page.getByRole('heading', { name: 'Transformer' }).waitFor()
  await push('opus', 'awaiting_input')
  await push('fable', 'running')

  // The page says who waits, that its clock is stopped, and leads straight to the request.
  const banner = page.locator('[data-benchmark-waiting-banner]')
  await banner.waitFor()
  assert.match(await banner.innerText(), /opus · medium attend ta réponse\. Son chronomètre est arrêté/)
  assert.equal(await banner.getByRole('link', { name: 'Répondre' }).getAttribute('href'), '/discussions/conv-opus')
  await page.locator('[data-benchmark-waiting]').first().waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling')
  await page.screenshot({ path: join(shots, `${profile}-${phone ? 'phone' : 'wide'}-page.png`) })

  if (phone) await page.locator('[data-navigation-trigger]').first().click()
  const rail = page.locator('[data-nav-rail]')
  await rail.waitFor()
  // Waiting outranks running on the benchmarks entry, and counts in Activity's badge.
  await rail.locator('[data-nav-space="benchmarks"] .nav-tone-awaiting').waitFor()
  await rail.getByRole('button', { name: /^Benchmarks — 1 à débloquer · 1 en cours$/ }).waitFor()
  assert.equal(await rail.locator('[data-nav-space="activity"] .nav-rail-badge').innerText(), '1')

  // The benchmark page opens its own space: the list is already there.
  const listed = page.locator('[data-nav-column="benchmarks"] a.nav-benchmark').filter({ hasText: 'Transformer' })
  assert.match(await listed.getAttribute('title'), /Attend ta réponse/)
  assert.equal(await listed.locator('.bg-caution').count(), 1)

  await rail.locator('[data-nav-space="activity"]').click()
  const waiting = page.locator('[data-nav-column="activity"] [data-activity-section="awaiting"] [data-activity-benchmark-run]')
  await waiting.waitFor()
  assert.match(await waiting.innerText(), /opus · medium[\s\S]*Benchmarks · Transformer/)
  assert.equal(await waiting.locator('a').getAttribute('href'), '/discussions/conv-opus')
  // Still grouped under its benchmark among running work.
  await page.locator('[data-nav-column="activity"] [data-activity-section="running"]').getByText('Transformer').waitFor()
  await page.screenshot({ path: join(shots, `${profile}-${phone ? 'phone' : 'wide'}-activity.png`) })

  // Answered: every signal goes away without a reload.
  await push('opus', 'running')
  await page.locator('[data-nav-column="activity"] [data-activity-benchmark-run]').waitFor({ state: 'detached' })
  await rail.locator('[data-nav-space="benchmarks"] .nav-tone-running').waitFor()
  assert.equal(await rail.locator('[data-nav-space="activity"] .nav-rail-badge').count(), 0)
  if (phone) await page.keyboard.press('Escape')
  await page.locator('[data-benchmark-waiting-banner]').waitFor({ state: 'detached' })
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
  await mkdir(shots, { recursive: true })

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const errors = []
  for (const [phone, viewport] of [[false, { width: 1440, height: 900 }], [true, { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript((origin) => { if (location.origin === origin) localStorage.setItem('sillage.locale', 'fr') }, new URL(base).origin)
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`server ${phone ? 'phone' : 'wide'}: ${error.message}`))
    await check(page, base, 'server', phone)
    await context.close()
  }

  // Desktop serves its own build behind a handshake; the same signals must hold there.
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
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await desktopContext.addInitScript(() => { if (window === window.top) localStorage.setItem('sillage.locale', 'fr') })
  await desktopContext.addCookies([{ name: 'sillage_session', value: handshake.session, url: desktopOrigin }])
  const settings = await desktopContext.request.patch(desktopOrigin + '/api/me/settings', { data: { onboarding: { pending: false } } })
  assert.ok(settings.ok(), await settings.text())
  const desk = await desktopContext.newPage()
  desk.on('pageerror', (error) => errors.push(`desktop: ${error.message}`))
  await check(desk, desktopOrigin, 'desktop', false)

  assert.deepEqual(errors, [])
  console.log('benchmark-waiting-ui-check: ok; screenshots: ' + shots)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
