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

// Following up on finished runs, and commenting on them: the button on the table and the outputs, the dialog that sends one
// correction to several runs, and the badge that says a result needed help, wherever the variant
// shows. Disposable Server and Desktop instances; the benchmark list is stubbed, so no model runs.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-benchmark-follow-up-'))
const shots = process.env.BENCHMARK_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-benchmark-follow-up-shots-')))
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
  { id: 'v1', label: 'Opus 5.5', config: { agent: 'claude', model: 'opus', effort: 'medium' } },
  { id: 'v2', label: 'Sonnet 5.5', config: { agent: 'claude', model: 'sonnet', effort: 'medium' } },
  { id: 'v3', label: 'Haiku 5.5', config: { agent: 'claude', model: 'haiku', effort: 'medium' } },
].map((variant) => ({ ...variant, technicalLabel: `claude-${variant.config.model} · medium`, labelIsCustom: false, model: null, listPrice: null, publicName: null }))
const metrics = (durationMs) => ({
  version: 3, durationMs, elapsedMs: durationMs, waitingMs: 0, firstTextMs: 5000,
  inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1,
  toolCalls: 2, toolErrors: 0, toolDurationMs: 30, assistantMessages: 2, outputChars: 400, contextTokens: 3000,
  model: null, toolsByName: { Bash: 2 },
})
const check = (passed) => ({ passed, exitCode: passed ? 0 : 1, timedOut: false, stdout: passed ? '' : 'keys do not play', stderr: '', durationMs: 10 })
const FIRST = 'Les touches ne jouent aucun son : corrige le clavier.'
const COMMENT = 'Le plus propre, mais il a fallu le corriger.'
const runOf = (id, variantId, extra = {}) => ({
  id, variantId, repetition: 1, status: 'succeeded', conversationId: `conv-${id}`, startedAt: Date.now() - 600_000, finishedAt: Date.now() - 60_000,
  cliVersion: '2.1.325', error: null, metrics: metrics(300_000), response: 'Fait.', check: check(true), files: [], previewToken: null,
  rating: null, ratingNote: null, followUps: [], ...extra,
})
const initial = () => ({
  id: 'piano', name: 'Piano', prompt: 'Un piano jouable au clavier', variants, comparisons: [],
  repetitions: 1, concurrency: 3, maxDurationMinutes: 30, inputs: [], checkScript: 'test -f index.html', checkTimeoutSeconds: 30,
  seriesId: null, createdAt: Date.now(), updatedAt: Date.now(),
  runs: [
    runOf('opus', 'v1'),
    // Already corrected once: its numbers include the second turn.
    runOf('sonnet', 'v2', { followUps: [{ text: FIRST, sentAt: Date.now() - 120_000 }], metrics: metrics(420_000), ratingNote: COMMENT }),
    runOf('haiku', 'v3', { status: 'failed', error: 'Check failed', check: check(false), rating: 2 }),
  ],
})

/** Stubs the list and the follow-up route; returns the bodies the page sent. */
async function stub(page) {
  let benchmark = initial()
  const sent = []
  await page.route('**/api/benchmarks', (route) => route.fulfill({ json: [benchmark] }))
  await page.route('**/api/benchmarks/piano/follow-ups', async (route) => {
    const body = route.request().postDataJSON()
    sent.push(body)
    benchmark = {
      ...benchmark,
      runs: benchmark.runs.map((entry) => body.runIds.includes(entry.id)
        ? { ...entry, status: 'running', finishedAt: null, metrics: null, check: null, rating: null, followUps: [...entry.followUps, { text: body.text, sentAt: Date.now() }] }
        : entry),
    }
    await route.fulfill({ json: benchmark })
  })
  await page.route('**/api/benchmarks/piano/runs/*/rating', async (route) => {
    const runId = route.request().url().split('/runs/')[1].split('/')[0]
    const body = route.request().postDataJSON()
    sent.push({ runId, ...body })
    benchmark = { ...benchmark, runs: benchmark.runs.map((entry) => (entry.id === runId ? { ...entry, rating: body.rating, ratingNote: body.note } : entry)) }
    await route.fulfill({ json: benchmark })
  })
  await page.route('**/api/benchmarks/piano/share', (route) => route.fulfill({ json: { canPublish: true, runs: [], shares: [] } }))
  return sent
}

async function scenario(page, base, profile, phone) {
  const sent = await stub(page)
  const shot = (name) => page.screenshot({ path: join(shots, `${profile}-${phone ? 'phone' : 'wide'}-${name}.png`) })
  await page.goto(`${base}/benchmarks/piano`)
  await page.getByRole('heading', { name: 'Piano' }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scrolling')

  // The corrected variant says so on its line, and opens on what was written.
  const table = page.locator('[data-benchmark-results]')
  const badge = table.locator('[data-follow-up-badge="1"]')
  assert.equal(await badge.count(), 1)
  assert.match(await badge.innerText(), /1 retour/)
  await badge.click()
  await page.getByRole('dialog', { name: 'Retours humains' }).getByText(FIRST).waitFor()
  await shot('badge')
  await page.keyboard.press('Escape')

  // Every finished run can be followed up from its line.
  assert.equal(await table.locator('[data-follow-up-open]').count(), 3)
  await table.locator('[data-follow-up-open="haiku"]').click()
  const dialog = page.locator('[data-follow-up-dialog]')
  await dialog.waitFor()
  assert.equal(await dialog.locator('[data-follow-up-run="haiku"]').isChecked(), true)
  assert.equal(await dialog.locator('[data-follow-up-run="opus"]').isChecked(), false)
  // A failed check reads as such, and a rated run warns that its rating goes.
  await dialog.getByText('contrôle échoué').waitFor()
  await dialog.getByText(/Les étoiles de ces runs sont effacées/).waitFor()
  const send = page.getByRole('button', { name: 'Envoyer', exact: true })
  assert.equal(await send.isDisabled(), true, 'nothing to send without a text')
  await dialog.locator('[data-follow-up-text]').fill('Le son ne se déclenche pas : branche les touches.')
  await dialog.locator('[data-follow-up-run="opus"]').check()
  await shot('dialog')
  await page.getByRole('button', { name: 'Envoyer à 2 runs' }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.deepEqual(sent, [{ runIds: ['opus', 'haiku'], text: 'Le son ne se déclenche pas : branche les touches.' }])

  // Reopened: running again, no button until they finish, and the badge counts the new follow-up.
  await table.locator('[data-benchmark-run="running"]').nth(1).waitFor()
  assert.equal(await table.locator('[data-follow-up-open]').count(), 1)
  assert.equal(await table.locator('[data-follow-up-badge="1"]').count(), 3)
  await shot('table')

  // The outputs and the comparison carry the same mark.
  await page.getByRole('tab', { name: /Productions/ }).click()
  await page.locator('[data-output-column] [data-follow-up-badge="1"]').first().waitFor()
  assert.equal(await page.locator('[data-output-column] [data-follow-up-badge]').count(), 3)
  assert.equal(await page.locator('[data-output-column] [data-follow-up-open]').count(), 1)
  await shot('outputs')

  // A comment needs no stars, is kept when written, and marks the variant's line.
  const sonnetCard = page.locator('[data-output-column="Sonnet 5.5"]')
  const comment = sonnetCard.locator('[data-benchmark-comment]')
  assert.equal(await comment.inputValue(), COMMENT)
  await comment.fill('Le plus propre, sans aide cette fois.')
  await comment.blur()
  for (let i = 0; i < 50 && !sent.some((entry) => entry.runId === 'sonnet'); i++) await delay(100)
  // Saved with the comment alone: the run has no stars.
  assert.deepEqual(sent.find((entry) => entry.runId === 'sonnet'), { runId: 'sonnet', rating: null, note: 'Le plus propre, sans aide cette fois.' })
  await page.getByRole('tab', { name: /Mesures/ }).click()
  const commentBadge = page.locator('[data-benchmark-results] [data-comment-badge="1"]')
  assert.equal(await commentBadge.count(), 1)
  await commentBadge.click()
  await page.getByRole('dialog', { name: 'Ton avis' }).getByText('Le plus propre, sans aide cette fois.').waitFor()
  await page.keyboard.press('Escape')

  // Sharing offers the comments, off by default.
  await page.getByRole('button', { name: /Partager/ }).first().click()
  const commentsOption = page.getByRole('switch', { name: 'Tes commentaires' })
  await commentsOption.waitFor()
  assert.equal(await commentsOption.getAttribute('aria-checked'), 'false')
  await shot('share')
  await page.keyboard.press('Escape')

  await page.goto(`${base}/benchmarks/piano?tab=compare&vs=v1,v2`)
  await page.locator('[data-compare-head="v2"] [data-follow-up-badge="1"]').first().waitFor()
  await page.locator('[data-compare-head="v2"] [data-comment-badge="1"]').first().waitFor()
  await shot('compare')
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
    await scenario(page, base, 'server', phone)
    await context.close()
  }

  // Desktop serves its own build behind a handshake; the same flow must hold there.
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
  await scenario(desk, desktopOrigin, 'desktop', false)

  assert.deepEqual(errors, [])
  console.log('benchmark-follow-up-ui-check: ok; screenshots: ' + shots)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
