import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Card #61: `[agents.claude] enabled = false` must stop every launch, not only the
// interface's suggestions. Claude points to a fake binary that leaves a marker when
// run, so any spawn shows up with its arguments. Desktop and phone viewports, real API, temporary database.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-disabled-cli-'))
const marker = join(data, 'claude-was-launched')
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

const launched = () => stat(marker).then(() => true, () => false)

try {
  const fakeClaude = join(data, 'fake-claude')
  await writeFile(fakeClaude, `#!/bin/sh\necho "$PPID $*" >> '${marker}'\necho 2.1.312\n`)
  await chmod(fakeClaude, 0o755)
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, `[agents.claude]\nenabled = false\nbinary = "${fakeClaude}"\n[agents.grok]\nbinary = "/nonexistent/grok"\n`)
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
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'phone', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block', hasTouch: viewport.name === 'phone' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const before = (await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()).length
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    // The draft must not ask for Claude's models or usage: each probe would only bring back a refusal.
    const probes = []
    page.on('request', (request) => { if (/\/api\/agents\/claude\/(models|usage)/.test(request.url())) probes.push(request.url()) })

    // 1. Explicit `?agent=claude`: the banner explains, the composer refuses input.
    await page.goto(`${base}/p/${project.id}/c/new?agent=claude`)
    await page.getByText('Désactivé dans la configuration du serveur.').first().waitFor()
    assert.equal(await page.getByPlaceholder('Conversation en lecture seule').isDisabled(), true)
    await page.waitForLoadState('networkidle')
    assert.equal(await page.getByText('Liste des modèles indisponible').count(), 0)
    assert.equal(await page.getByText("La consommation de ce CLI n'a pas pu être lue.").count(), 0)
    await page.screenshot({ path: join(tmpdir(), `disabled-cli-${viewport.name}-banner.png`) })

    // 2. The race from the card: Claude is selected while availability is still loading.
    // Sending must wait, keep the text and say why.
    let releaseAvailability
    const held = new Promise((resolve) => { releaseAvailability = resolve })
    await page.route('**/api/agents', async (route) => { await held; await route.continue() })
    await page.goto(`${base}/p/${project.id}/c/new?agent=claude`)
    const input = page.getByPlaceholder('Écris ton message…')
    await input.fill('Ne doit jamais partir')
    await input.press('Enter')
    await page.getByText('Vérification des CLI disponibles. Réessaie dans un instant.').waitFor()
    assert.equal(await input.inputValue(), 'Ne doit jamais partir')
    await page.screenshot({ path: join(tmpdir(), `disabled-cli-${viewport.name}-pending.png`) })
    releaseAvailability()
    await page.getByText('Désactivé dans la configuration du serveur.').first().waitFor()
    await page.unroute('**/api/agents')
    await page.waitForLoadState('networkidle')
    assert.deepEqual(probes, [], 'model or usage probe for the disabled CLI')

    // 3. Bypassing the interface: the API refuses creation and sends, with a translated code.
    const seeded = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
    const existing = seeded.find((entry) => entry.agent === 'claude')
    assert.ok(existing?.config, 'demo seed provides a Claude conversation with its config')
    const created = await context.request.post(`${base}/api/projects/${project.id}/conversations`, {
      data: { agent: 'claude', config: existing.config, firstMessage: { clientMessageId: crypto.randomUUID(), text: 'hello' } },
    })
    assert.equal(created.status(), 503, await created.text())
    assert.equal((await created.json()).error.code, 'cli_disabled')
    const list = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
    assert.equal(list.length, before, 'no conversation row left behind')
    const sent = await context.request.post(`${base}/api/conversations/${existing.id}/messages`, {
      data: { clientMessageId: crypto.randomUUID(), text: 'hello' },
    })
    assert.equal(sent.status(), 503, await sent.text())
    assert.equal((await sent.json()).error.code, 'cli_disabled')

    assert.deepEqual(errors, [])
    await context.close()
    console.log(`${viewport.name}: ok`)
  }
  // The marker lists each launch's arguments: `--version` is a probe, `stream-json` a session or catalog.
  assert.equal(await launched(), false, `the disabled Claude binary was spawned:\n${await readFile(marker, 'utf8').catch(() => '')}`)
  console.log('disabled CLI check passed: no Claude launch, screenshots in', tmpdir())
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
