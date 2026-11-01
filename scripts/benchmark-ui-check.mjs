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

// Real components, API and Claude CLI in a temporary database: two trivial runs of the same
// prompt, then their measurements in the table. Screenshots go to BENCHMARK_SHOTS or a
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
  page.on('pageerror', (error) => errors.push(error.message))
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
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Réponds seulement « OK », sans utiliser aucun outil.')
  const variants = page.locator('[data-benchmark-variant]')
  await variants.first().waitFor()
  // The model catalog comes from the real CLI: wait for the effort select before changing it.
  await variants.first().getByRole('combobox', { name: 'Effort de réflexion', exact: true }).waitFor({ timeout: 60_000 })
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

  benchmark = await until('both runs settled', (entry) => entry.runs.every((run) => run.status !== 'pending' && run.status !== 'running'), 300_000)
  for (const run of benchmark.runs) {
    assert.equal(run.status, 'succeeded', run.error ?? '')
    assert.ok(run.metrics, 'metrics folded')
    assert.ok(run.metrics.durationMs > 0, 'duration measured')
    assert.ok(run.metrics.outputTokens > 0, 'tokens reported')
    assert.equal(run.metrics.toolCalls, 0)
    assert.ok(run.metrics.model, 'model announced')
  }

  // --- Table ----------------------------------------------------------------------
  await page.goto(`${base}/benchmarks/${benchmark.id}`)
  const table = page.locator('[data-benchmark-results]')
  await table.locator('[data-benchmark-run="succeeded"]').nth(1).waitFor()
  await table.getByRole('columnheader', { name: 'Durée', exact: true }).getByRole('button').click()
  await page.getByText('Terminé', { exact: true }).first().waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-results-desktop.png') })

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
  await page.goto(`${base}/benchmarks/new`)
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ animations: 'disabled', path: join(shots, 'benchmark-form-mobile.png') })

  // --- Deletion removes the runs' conversations -----------------------------------
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/benchmarks/${benchmark.id}`)
  await page.getByRole('button', { name: 'Supprimer le benchmark', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer', exact: true }).click()
  await page.getByText('Aucun benchmark', { exact: true }).first().waitFor()
  const remaining = await api('/api/conversations')
  assert.equal(remaining.some((entry) => entry.benchmarkId === benchmark.id), false)

  assert.deepEqual(errors, [])
  console.log(`benchmark-ui-check: ok (captures dans ${shots})`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
