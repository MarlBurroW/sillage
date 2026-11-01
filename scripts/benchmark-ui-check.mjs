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

// Real components, API and Claude CLI in a temporary database: two short runs of the same
// prompt with a starting file and a check script, then their measurements, outputs and export. Screenshots go to BENCHMARK_SHOTS or a
// temporary directory announced at completion.
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
  const api = async (path) => (await context.request.get(`${base}${path}`)).json()
  const mine = async () => (await api('/api/benchmarks'))[0]
  const until = async (label, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const benchmark = await mine()
      if (benchmark && predicate(benchmark)) return benchmark
      await delay(1000)
    }
    throw new Error(`Timeout: ${label}\n${JSON.stringify(await mine(), null, 1)}\n${server.diagnostics}`)
  }

  const page = await context.newPage()
  const errors = []
  // Playwright's `serviceWorkers: 'block'` patches navigator.serviceWorker in every frame, which
  // throws inside the previews' opaque-origin sandbox. That is the harness, not the page.
  page.on('pageerror', (error) => {
    if (!/serviceWorker.*sandboxed/.test(error.message)) errors.push(error.message)
  })
  await mkdir(shots, { recursive: true })

  // --- Empty state and sidebar section --------------------------------------------
  await page.goto(`${base}/benchmarks`)
  const nav = page.getByRole('navigation', { name: 'Navigation', exact: true })
  const section = nav.locator('[data-sidebar-benchmarks]')
  await section.getByText('Benchmarks', { exact: true }).waitFor()
  await page.getByText('Aucun benchmark', { exact: true }).first().waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmarks-empty-desktop.png') })

  // --- Creation: two Claude variants differing by effort --------------------------
  await page.getByRole('link', { name: 'Nouveau benchmark', exact: true }).first().click()
  await page.getByRole('heading', { name: 'Nouveau benchmark', exact: true }).waitFor()
  await page.getByRole('textbox', { name: 'Nom', exact: true }).fill('Effort faible contre moyen')
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(
    'Lis le fichier joint. Crée dans ton dossier de travail un fichier index.html contenant seulement un titre h1 avec le mot secret. Réponds ensuite seulement par le mot secret.',
  )
  // Starting file: uploaded like a composer attachment, then sent to every run.
  const brief = join(data, 'consigne.txt')
  await writeFile(brief, 'Le mot secret est HIBOU.\n')
  await page.locator('input[type="file"]').setInputFiles(brief)
  await page.getByText('consigne.txt', { exact: true }).waitFor()
  await page.getByRole('textbox', { name: 'Script de vérification', exact: true }).fill('grep -q HIBOU index.html && grep -q HIBOU "$SILLAGE_RESPONSE_FILE"')
  const variants = page.locator('[data-benchmark-variant]')
  await variants.first().waitFor()
  // The model catalog comes from the real CLI: wait for the effort select before changing it.
  await variants.first().getByRole('combobox', { name: 'Effort de réflexion', exact: true }).waitFor({ timeout: 60_000 })
  // Unattended runs: a mode that asks would stall on the first write. The second variant copies this one.
  await page.getByText('Les runs tournent sans surveillance', { exact: false }).waitFor()
  await variants.first().getByRole('combobox', { name: 'Permissions', exact: true }).click()
  await page.getByRole('option', { name: /^Tout autoriser/ }).click()
  await page.getByRole('button', { name: 'Ajouter une variante', exact: true }).click()
  await variants.nth(1).getByRole('combobox', { name: 'Effort de réflexion', exact: true }).click()
  await page.getByRole('option', { name: /^Faible/ }).click()
  await page.getByText('2 sessions seront lancées.', { exact: true }).waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-form-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Lancer le benchmark', exact: true }).click()

  // --- Results page while running --------------------------------------------------
  await page.getByRole('heading', { name: 'Effort faible contre moyen', exact: true }).waitFor()
  let benchmark = await mine()
  assert.equal(benchmark.variants.length, 2)
  assert.equal(benchmark.runs.length, 2)
  assert.notEqual(benchmark.variants[0].config.effort, benchmark.variants[1].config.effort)
  // Resolved at creation: the frozen variant names the model that runs, not the CLI default sentinel.
  assert.ok(benchmark.variants[0].config.model, 'resolved model')
  assert.deepEqual(benchmark.inputs.map((input) => input.filename), ['consigne.txt'])
  assert.ok(benchmark.checkScript)
  await section.getByText('Effort faible contre moyen').waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-running-desktop.png') })

  // Sequential: the second run waits for the first.
  benchmark = await until('first run launched', (entry) => entry.runs.some((run) => run.status === 'running'), 60_000)
  assert.equal(benchmark.runs.filter((run) => run.status === 'running').length, 1)
  assert.equal(benchmark.runs.filter((run) => run.status === 'pending').length, 1)

  // Runs stay out of Discussions.
  const conversations = await api('/api/conversations')
  const runThreads = conversations.filter((entry) => entry.benchmarkId === benchmark.id)
  assert.equal(runThreads.length, 1)
  assert.equal(runThreads[0].projectId, null)
  assert.equal(runThreads[0].titleSetByUser, true)
  const discussions = nav.locator('.sidebar-personal').first()
  await discussions.getByRole('button', { name: 'Discussions', exact: true }).click()
  await discussions.locator('ul').waitFor()
  assert.equal(await nav.getByText(runThreads[0].title, { exact: true }).count(), 0, 'runs are not listed among discussions')

  // The first run's message carries the starting file as an attachment of its own.
  const firstThread = await api(`/api/conversations/${runThreads[0].id}/events?after=0`)
  const firstMessage = firstThread.entries.map((entry) => entry.event).find((event) => event.type === 'message.completed' && event.role === 'user')
  assert.ok(JSON.stringify(firstMessage.blocks).includes('consigne.txt'), 'starting file attached')

  benchmark = await until('both runs settled', (entry) => entry.runs.every((run) => !['pending', 'running', 'checking'].includes(run.status)), 400_000)
  for (const run of benchmark.runs) {
    assert.equal(run.status, 'succeeded', run.error ?? '')
    assert.ok(run.metrics, 'metrics folded')
    assert.ok(run.metrics.durationMs > 0, 'duration measured')
    assert.ok(run.metrics.outputTokens > 0, 'tokens reported')
    assert.ok(run.metrics.toolCalls > 0, 'the page was written with a tool')
    assert.ok(run.metrics.model, 'model announced')
    assert.match(run.cliVersion ?? '', /^\d+\.\d+\.\d+/)
    assert.match(run.response ?? '', /HIBOU/)
    assert.equal(run.check?.passed, true, JSON.stringify(run.check))
    assert.ok(run.files.some((file) => file.path === 'index.html' && file.kind === 'page'), JSON.stringify(run.files))
    assert.ok(run.previewToken)
  }

  // The preview needs no session: an anonymous request gets the page with its sandbox policy.
  const anonymous = await fetch(`${base}/api/benchmark-previews/${benchmark.runs[0].previewToken}/index.html`)
  assert.equal(anonymous.status, 200)
  assert.match(anonymous.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts/)
  assert.match(await anonymous.text(), /HIBOU/)

  // --- Table ----------------------------------------------------------------------
  await page.goto(`${base}/benchmarks/${benchmark.id}`)
  const table = page.locator('[data-benchmark-results]')
  await table.locator('[data-benchmark-run="succeeded"]').nth(1).waitFor()
  await table.getByRole('columnheader', { name: 'Durée', exact: true }).getByRole('button').click()
  await page.getByText('Terminé', { exact: true }).first().waitFor()
  assert.equal(await table.locator('[data-benchmark-check="passed"]').count(), 2)
  await table.getByText('1/1 réussis').first().waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-results-desktop.png') })

  // Export: one CSV row per run with raw numbers.
  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: 'Exporter les résultats', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Mesures en CSV', exact: true }).click()
    })(),
  ])
  const csv = (await readFile(await csvDownload.path(), 'utf8')).split('\r\n')
  assert.equal(csv.length, 3)
  assert.match(csv[0], /^benchmark,variant,agent,model,effort,announced_model,cli_version,repetition,status,check_passed/)
  assert.match(csv[1], /,succeeded,true,0,/)

  // Outputs: the answer and the built page side by side, the page rendered in its sandbox.
  await page.getByRole('tab', { name: 'Productions', exact: true }).click()
  const outputs = page.locator('[data-benchmark-deliverables]')
  await outputs.getByText('index.html', { exact: true }).waitFor()
  const frames = outputs.locator('iframe[title="index.html"]')
  assert.equal(await frames.count(), 2)
  await outputs.frameLocator('iframe[title="index.html"]').first().locator('h1').getByText('HIBOU').waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-outputs-desktop.png') })

  // Blind review: shuffled letters, no CLI icon, measures hidden until revealed.
  await page.getByRole('button', { name: 'Évaluer à l’aveugle', exact: true }).click()
  const blindView = page.locator('[data-benchmark-blind]')
  await blindView.waitFor()
  assert.equal(await page.locator('[data-benchmark-results]').count(), 0, 'measures are hidden while blind')
  assert.equal(await page.getByRole('tab', { name: 'Mesures', exact: true }).count(), 0)
  const headings = blindView.locator('[data-output-column]')
  assert.deepEqual(await headings.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-output-column'))), ['Variante A', 'Variante B'])
  assert.equal(await headings.locator('svg').count(), 0, 'no CLI icon gives a variant away')
  await blindView.getByRole('radiogroup', { name: 'Note de Variante A', exact: true }).getByRole('radio', { name: '5 sur 5', exact: true }).click()
  await blindView.getByRole('radiogroup', { name: 'Note de Variante B', exact: true }).getByRole('radio', { name: '2 sur 5', exact: true }).click()
  await blindView.getByRole('textbox', { name: 'Commentaire sur cette note', exact: true }).first().fill('Titre net')
  await blindView.getByRole('textbox', { name: 'Commentaire sur cette note', exact: true }).first().blur()
  const rated = await until('ratings saved', (entry) => entry.runs.every((run) => run.rating !== null) && entry.runs.some((run) => run.ratingNote === 'Titre net'), 15_000)
  assert.deepEqual(rated.runs.map((run) => run.rating).sort(), [2, 5])
  // The page shows both, whatever order the replies came back in.
  await blindView.locator('[data-benchmark-rating="5"]').waitFor()
  await blindView.locator('[data-benchmark-rating="2"]').waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-blind-desktop.png') })
  await page.getByRole('button', { name: 'Révéler les variantes', exact: true }).click()
  await page.getByRole('tab', { name: 'Productions', exact: true }).waitFor()
  const revealed = await page.locator('[data-output-column]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-output-column')))
  assert.ok(revealed.every((name) => /^[AB] · default · (medium|low)$/.test(name ?? '')), JSON.stringify(revealed))

  // Ratings join the measures, as a column of their own.
  await page.getByRole('tab', { name: 'Mesures', exact: true }).click()
  await table.getByRole('columnheader', { name: 'Note', exact: true }).waitFor()
  await table.getByText('5/5', { exact: true }).waitFor()

  // Chart: one bar per variant at its median, with a tooltip on focus.
  await page.getByRole('tab', { name: 'Graphique', exact: true }).click()
  const chart = page.locator('[data-benchmark-chart]')
  await chart.getByRole('heading', { name: 'Durée', exact: true }).waitFor()
  assert.equal(await chart.locator('[data-chart-row]').count(), 2)
  await chart.locator('[data-chart-row]').first().focus()
  await chart.getByRole('tooltip').waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-chart-desktop.png') })
  await page.getByRole('tab', { name: 'Mesures', exact: true }).click()

  // The run opens as an ordinary conversation, headed back to its benchmark.
  await table.getByRole('link', { name: /Run 1/ }).first().click()
  await page.getByRole('link', { name: 'Run de benchmark', exact: true }).waitFor()
  const thread = await api(`/api/conversations/${benchmark.runs[0].conversationId}/events?after=0`)
  const injected = thread.entries.map((entry) => entry.event).filter((event) => event.type === 'prompt.injected')
  assert.equal(injected.length, 0, 'no platform prompt is injected into a run')
  await page.getByRole('link', { name: 'Run de benchmark', exact: true }).click()
  await page.getByRole('heading', { name: 'Effort faible contre moyen', exact: true }).waitFor()

  // --- Phone ----------------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await table.locator('[data-benchmark-run="succeeded"]').nth(1).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the table scrolls inside its frame')
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-results-mobile.png') })
  await page.getByRole('tab', { name: 'Productions', exact: true }).click()
  await page.locator('[data-benchmark-deliverables]').frameLocator('iframe[title="index.html"]').first().locator('h1').getByText('HIBOU').waitFor()
  assert.ok(await page.getByRole('heading', { name: 'Effort faible contre moyen', exact: true }).evaluate((node) => node.clientWidth > 150), 'the title keeps room on a phone')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'outputs scroll inside their frame')
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-outputs-mobile.png') })
  await page.goto(`${base}/benchmarks/new`)
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-form-mobile.png') })

  // --- Rerun: same benchmark again, compared in History ---------------------------
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/benchmarks/${benchmark.id}`)
  await page.getByRole('button', { name: 'Relancer', exact: true }).click()
  await page.waitForURL((url) => url.pathname.startsWith('/benchmarks/') && !url.pathname.endsWith(benchmark.id))
  const rerunId = new URL(page.url()).pathname.split('/').pop()
  const all = async () => api('/api/benchmarks')
  let copy = (await all()).find((entry) => entry.id === rerunId)
  assert.equal(copy.seriesId, benchmark.id)
  assert.equal(copy.prompt, benchmark.prompt)
  assert.deepEqual(copy.inputs.map((input) => input.filename), ['consigne.txt'])
  for (let i = 0; i < 400; i += 1) {
    copy = (await all()).find((entry) => entry.id === rerunId)
    if (copy.runs.every((run) => !['pending', 'running', 'checking'].includes(run.status))) break
    await delay(1000)
  }
  assert.ok(copy.runs.every((run) => run.status === 'succeeded' && run.check?.passed), JSON.stringify(copy.runs.map((run) => [run.status, run.error])))
  await page.getByRole('tab', { name: 'Historique (2)', exact: true }).click()
  const history = page.locator('[data-benchmark-series]')
  await history.waitFor()
  assert.equal(await history.locator('thead th').count(), 3)
  // The page polls every few seconds: wait for it to catch up with the settled API.
  await history.locator('[data-series-cell]').filter({ hasText: 'en cours' }).first().waitFor({ state: 'detached', timeout: 20_000 })
  await history.getByText('v2.1', { exact: false }).first().waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-history-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'history scrolls inside its frame')
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-history-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/benchmarks`)
  await page.locator(`[data-benchmark="Effort faible contre moyen"]`).getByText('Relance', { exact: true }).waitFor()

  // --- Deletion removes the runs' conversations -----------------------------------
  for (const target of [rerunId, benchmark.id]) {
    await page.goto(`${base}/benchmarks/${target}`)
    await page.getByRole('button', { name: 'Supprimer le benchmark', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Supprimer', exact: true }).click()
    await page.waitForURL((url) => url.pathname === '/benchmarks')
  }
  await page.getByText('Aucun benchmark', { exact: true }).first().waitFor()
  const remaining = await api('/api/conversations')
  assert.equal(remaining.some((entry) => entry.benchmarkId === benchmark.id || entry.benchmarkId === rerunId), false)

  assert.deepEqual(errors, [])
  console.log(`benchmark-ui-check: ok (captures dans ${shots})`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
