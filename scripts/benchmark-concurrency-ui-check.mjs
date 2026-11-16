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


async function checkResults(page, base, profile) {
  const variants = ['Opus', 'Sonnet', 'Codex'].map((label, index) => ({
    id: `v${index}`, label, config: { agent: index === 2 ? 'codex' : 'claude', model: label, effort: 'medium' },
  }))
  const benchmark = {
    id: 'comparison', name: 'Comparaison des résultats', prompt: 'Créer un piano', variants,
    repetitions: 2, concurrency: 10, maxDurationMinutes: 20, inputs: [], checkScript: null,
    checkTimeoutSeconds: 30, seriesId: null, createdAt: Date.now(), updatedAt: Date.now(),
    runs: variants.flatMap((variant, index) => [1, 2].map((repetition) => ({
      id: `${variant.id}-${repetition}`, variantId: variant.id, repetition, status: 'succeeded', conversationId: null,
      startedAt: 1, finishedAt: 90001, cliVersion: 'test', error: null, check: null,
      response: `Résultat de ${variant.label}`, previewToken: `preview-${variant.id}-${repetition}`, rating: null, ratingNote: null,
      metrics: { version: 2, durationMs: 90000, waitingMs: 0, firstTextMs: 5000,
        inputTokens: [62237, 98887, 181027][index], outputTokens: 10000, cacheReadTokens: 38462, cacheCreationTokens: 22512,
        costUsd: index === 2 ? null : 0.3868893, toolCalls: 2, toolErrors: 0, toolDurationMs: 30,
        assistantMessages: 2, outputChars: 400, contextTokens: 35000, model: variant.label, toolsByName: { Write: 2 } },
      files: [{ path: index === 1 ? 'piano.html' : 'index.html', kind: 'page', sizeBytes: 1500 },
        ...(index === 0 ? [{ path: 'about.html', kind: 'page', sizeBytes: 500 }] : []),
        { path: index === 1 ? 'notes.md' : 'README.md', kind: 'text', sizeBytes: 100 }],
    }))),
  }
  await page.unroute('**/api/benchmarks')
  await page.route('**/api/benchmarks', (route) => route.fulfill({ json: [benchmark] }))
  await page.route('**/api/benchmark-previews/**', (route) => route.fulfill({
    contentType: route.request().url().endsWith('.md') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
    body: route.request().url().endsWith('.md') ? '# Notes' : '<html><body style="margin:0;background:#252d35;color:#e9d9bd;display:grid;place-content:center;height:100vh;font:24px sans-serif">Aperçu du piano</body></html>',
  }))
  for (const [size, viewport] of [['desktop', { width: 1600, height: 1100 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => { localStorage.removeItem('sillage.benchmark.blind.comparison'); localStorage.removeItem('sillage.benchmark.outputs') })
    await page.goto(base + '/benchmarks/comparison')
    const facts = page.locator('dl').filter({ hasText: 'Exécutions simultanées' })
    await facts.waitFor()
    const aligned = await facts.evaluate((dl) => [...dl.children].map((fact) => {
      const label = fact.querySelector('dt').getBoundingClientRect()
      const value = fact.querySelector('dd').getBoundingClientRect()
      return Math.abs(label.y + label.height / 2 - value.y - value.height / 2) < 2
    }))
    assert.ok(aligned.every(Boolean), 'labels and values stay vertically aligned')
    const run = page.locator('[data-benchmark-run]').first()
    await run.waitFor()
    assert.match(await run.textContent(), /62[\s\u202f\u00a0]?237/)
    const codex = page.locator('[data-benchmark-run]').nth(4)
    const headings = await page.locator('[data-benchmark-results] thead th').allTextContents()
    const costIndex = headings.findIndex((text) => text.trim() === 'Coût')
    assert.equal((await codex.locator('td').nth(costIndex).textContent()).trim(), '—')
    await page.screenshot({ path: join(shots, `${profile}-${size}-measures.png`) })

    for (const format of ['csv', 'json']) {
      await page.getByRole('button', { name: 'Exporter les résultats', exact: true }).click()
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('menuitem', { name: format === 'csv' ? 'Mesures en CSV' : 'Tout en JSON', exact: true }).click(),
      ])
      const content = await readFile(await download.path(), 'utf8')
      if (format === 'json') {
        const exported = JSON.parse(content)
        assert.equal(exported.runs[0].metrics.inputTokens, 62237)
        assert.equal(exported.runs[4].metrics.costUsd, null)
        assert.equal(exported.runs[0].previewToken, undefined)
      } else {
        const rows = content.split('\r\n').map((row) => row.split(','))
        assert.equal(rows[1][rows[0].indexOf('input_tokens')], '62237')
        assert.equal(rows[5][rows[0].indexOf('cost_usd')], '')
      }
    }

    await page.getByRole('tab', { name: 'Graphique', exact: true }).click()
    await page.getByRole('combobox', { name: 'Mesure', exact: true }).click()
    await page.getByRole('option', { name: 'Tokens entrée', exact: true }).click()
    assert.match(await page.locator('[data-chart-row="Opus"]').getAttribute('aria-label'), /62[\s\u202f\u00a0]?237/)
    await page.screenshot({ path: join(shots, `${profile}-${size}-tokens.png`) })
    await page.getByRole('combobox', { name: 'Mesure', exact: true }).click()
    await page.getByRole('option', { name: 'Coût', exact: true }).click()
    assert.match(await page.locator('[data-chart-row="Codex"]').getAttribute('aria-label'), /—/)

    await page.getByRole('tab', { name: 'Productions', exact: true }).click()
    const outputs = page.locator('[data-benchmark-deliverables]')
    const index = outputs.locator('iframe[title="index.html"]').first()
    const piano = outputs.locator('iframe[title="piano.html"]')
    await index.waitFor()
    const a = await index.boundingBox(), b = await piano.boundingBox()
    assert.ok(Math.abs(a.y - b.y) < 2, 'different filenames of the same kind share a row')
    assert.ok(b.x > a.x + a.width, 'variants occupy neighboring columns')
    // A card shows one thing at a time: the other pages of a variant are in its own menu.
    await outputs.locator('[data-output-column]').first().getByRole('button', { name: 'Choisir ce que montre cette carte' }).click()
    await page.getByRole('menuitem', { name: /about\.html/ }).waitFor()
    await page.keyboard.press('Escape')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal scrolling stays inside the comparison')
    await page.screenshot({ path: join(shots, `${profile}-${size}-outputs.png`) })
    await outputs.getByRole('radio', { name: 'Run 2', exact: true }).click()
    assert.match(await piano.getAttribute('src'), /preview-v1-2/)

    await page.getByRole('button', { name: 'Évaluer à l’aveugle', exact: true }).click()
    await page.locator('[data-benchmark-blind]').waitFor()
    assert.ok(!(await page.locator('[data-benchmark-blind] [data-output-column]').allTextContents()).some((text) => text.includes('Sonnet')), 'blind headings hide the model')
    const blindIndex = page.locator('[data-benchmark-blind] iframe[title="index.html"]').first()
    const blindPiano = page.locator('[data-benchmark-blind] iframe[title="piano.html"]')
    assert.ok(Math.abs((await blindIndex.boundingBox()).y - (await blindPiano.boundingBox()).y) < 2)
    await page.getByRole('button', { name: 'Révéler les variantes', exact: true }).click()
  }
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
  await checkResults(page, base, 'server')
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
  await desktopContext.addInitScript(() => { if (window === window.top) localStorage.setItem('sillage.locale', 'fr') })
  await desktopContext.addCookies([{ name: 'sillage_session', value: handshake.session, url: desktopOrigin }])
  const settings = await desktopContext.request.patch(desktopOrigin + '/api/me/settings', { data: { onboarding: { pending: false } } })
  assert.ok(settings.ok(), await settings.text())
  const desk = await desktopContext.newPage()
  desk.on('pageerror', (error) => { if (!/serviceWorker.*sandboxed/.test(error.message)) errors.push(error.message) })
  await checkForm(desk, desktopOrigin, 'desktop')
  await checkResults(desk, desktopOrigin, 'desktop')
  assert.deepEqual(errors, [])
  console.log('benchmark-concurrency-ui-check: ok; screenshots: ' + shots)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
