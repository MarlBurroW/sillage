import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Real token creation/editing and both transports, with deterministic display catalogs.
// Server and Desktop each use a disposable database; no real agent is launched.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-api-mcp-check-'))
const shots = process.env.API_MCP_SHOTS ?? await mkdtemp(join(tmpdir(), 'sillage-api-mcp-shots-'))
const processes = []
const units = []
let browser
let page

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}
function capture(child) {
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.diagnostics = (child.diagnostics + chunk).slice(-10000) })
  return child
}
function run(args, cwd, env) {
  const child = capture(spawn(process.execPath, args, { cwd, env, stdio: 'pipe' }))
  processes.push(child)
  return child
}
function service(name, env, entry = 'src/main.ts') {
  const unit = `sillage-app-api-mcp-${name}-${process.pid}`
  units.push(unit)
  return capture(spawn('systemd-run', ['--user', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--working-directory=${serverDir}`,
    ...Object.entries(env).filter(([key]) => key.startsWith('SILLAGE_') || ['PATH', 'NODE_ENV'].includes(key)).map(([key, value]) => `--setenv=${key}=${value}`),
    process.execPath, '--import', 'tsx', entry], { stdio: 'pipe' }))
}
async function ready(url, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then(response => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}
const catalog = { models: ['alpha', 'beta'].map((value, index) => ({ value, displayName: value === 'alpha' ? 'Alpha' : 'Beta', description: '', hint: null, isDefault: index === 0, supportsFastMode: false, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'].map(value => ({ value, label: value, hint: null })) })), outputStyles: [] }

async function exercise(context, base, profile) {
  page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/agents/*/models*', route => route.fulfill({ json: catalog }))
  await context.request.patch(`${base}/api/me/settings`, { data: { onboarding: { pending: false } } })
  for (const [name, viewport] of [['wide', { width: 1920, height: 1080 }], ['laptop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    await page.goto(`${base}/settings/api`)
    await page.getByRole('heading', { name: 'API et MCP', exact: true }).waitFor()
    if (!(await page.getByRole('heading', { name: 'API REST', exact: true }).isVisible())) await page.getByText('Brancher un client externe', { exact: true }).click()
    await page.getByRole('heading', { name: 'API REST', exact: true }).waitFor()
    assert.ok(await page.getByRole('heading', { name: 'Serveur MCP', exact: true }).isVisible())
    await page.screenshot({ path: join(shots, `${profile}-${name}-overview.png`), fullPage: true })
    if (name === 'wide') {
      const bounds = await page.locator('[data-api-settings]').boundingBox()
      assert.ok(bounds.width > 1100, `Settings still narrow: ${bounds.width}`)
    }
    await page.getByRole('button', { name: 'Créer une clé', exact: true }).click()
    await page.getByRole('heading', { name: 'Nouvelle clé d’accès' }).waitFor()
    await page.getByRole('textbox', { name: 'Nom', exact: true }).fill(`${profile} external client`)
    assert.ok(await page.getByRole('checkbox', { name: /^Outils de projet/ }).isChecked())
    await page.getByRole('combobox', { name: 'Modèles autorisés', exact: true }).click()
    await page.getByRole('option', { name: 'Seulement la sélection' }).click()
    await page.getByRole('checkbox', { name: 'Alpha', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Beta', exact: true }).check()
    await page.getByRole('combobox', { name: 'Efforts autorisés', exact: true }).click()
    await page.getByRole('option', { name: 'Seulement la sélection' }).click()
    await page.getByRole('checkbox', { name: /^(low|Faible|Bas)$/i }).check()
    await page.getByRole('spinbutton', { name: 'Budget maximal par session (USD)' }).fill('2')
    await page.screenshot({ path: join(shots, `${profile}-${name}-permissions.png`), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    if (name !== 'phone') await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  }
  const created = page.waitForResponse(response => response.url().endsWith('/api/tokens') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Créer le jeton', exact: true }).click()
  const response = await created
  assert.equal(response.status(), 201, await response.text())
  const token = await response.json()
  assert.deepEqual(token.token.executionPolicy.agents, [{ agent: 'claude', models: ['alpha', 'beta'], efforts: ['low'], maxBudgetUsd: 2 }])
  await page.getByRole('heading', { name: 'Votre jeton', exact: true }).waitFor()
  assert.ok(await page.getByText(`Authorization: Bearer ${token.secret}`, { exact: true }).isVisible())
  // Do not put secrets into screenshot artifacts.
  await page.getByRole('button', { name: 'Terminé', exact: true }).click()
  await page.getByRole('button', { name: 'Modifier les permissions' }).click()
  await page.getByRole('checkbox', { name: 'Beta', exact: true }).uncheck()
  const updated = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/api/tokens/${token.token.id}`))
  await page.getByRole('button', { name: 'Enregistrer les permissions' }).click()
  assert.equal((await updated).status(), 200)
  await page.getByRole('button', { name: 'Modifier les permissions' }).waitFor()
  await page.screenshot({ path: join(shots, `${profile}-phone-saved.png`), fullPage: true })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, `${profile}-wide-saved.png`), fullPage: true })

  const headers = { authorization: `Bearer ${token.secret}` }
  const rpc = (body, session) => context.request.post(`${base}/api/v1/mcp`, { headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) }, data: body })
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ui-check', version: '1' } } })
  assert.equal(init.status(), 200, await init.text())
  const session = init.headers()['mcp-session-id']
  const mcpTools = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).json()).result
  const restTools = await (await context.request.get(`${base}/api/v1/tools`, { headers })).json()
  assert.deepEqual(mcpTools, restTools)
  const access = await (await context.request.get(`${base}/api/v1/access`, { headers })).json()
  assert.deepEqual(access.executionPolicy.agents[0].models, ['alpha'])
  assert.deepEqual(errors, [])
  await context.close()
}

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n[agents.antigravity]\nenabled = false\n')
  const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'server-data'), SILLAGE_WEB_ROOT: join(data, 'web') }
  delete env.SILLAGE_PROFILE
  delete env.SILLAGE_HANDSHAKE_FD
  const server = service('server', env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  await exercise(context, base, 'server')

  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...env, NODE_ENV: 'production' })
  assert.equal((await once(build, 'exit'))[0], 0, build.diagnostics)
  const handshakeFile = join(data, 'handshake.json')
  const launcher = join(data, 'desktop-launch.mjs')
  await writeFile(launcher, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { stdio: ['pipe', 'inherit', 'inherit', 'pipe'] });
let buffer = ''; child.stdio[3].on('data', chunk => { buffer += chunk; if (buffer.includes('\\n')) writeFileSync(${JSON.stringify(handshakeFile)}, buffer.split('\\n')[0]); });
process.stdin.pipe(child.stdin); child.on('exit', code => process.exit(code ?? 1));\n`)
  const desktop = service('desktop', { ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3', SILLAGE_PORT: String(await freePort()), SILLAGE_DATA_DIR: join(data, 'desktop-data'), SILLAGE_WEB_ROOT: webDist }, launcher)
  let handshake
  for (let i = 0; i < 200; i++) {
    if (desktop.exitCode !== null) throw new Error(desktop.diagnostics)
    handshake = await readFile(handshakeFile, 'utf8').then(JSON.parse).catch(() => null)
    if (handshake) break
    await delay(100)
  }
  assert.ok(handshake, desktop.diagnostics)
  const desktopBase = `http://127.0.0.1:${handshake.port}`
  const desktopContext = await browser.newContext({ locale: 'fr-FR', serviceWorkers: 'block' })
  await desktopContext.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await desktopContext.addCookies([{ name: 'sillage_session', value: handshake.session, url: desktopBase }])
  assert.equal((await (await desktopContext.request.get(`${desktopBase}/api/system/instance`)).json()).profile, 'desktop')
  await exercise(desktopContext, desktopBase, 'desktop')
  console.log(`api-mcp-ui-check: ok — captures in ${shots}`)
} catch (error) {
  await page?.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {})
  console.error(`Screenshots: ${shots}`)
  throw error
} finally {
  await browser?.close()
  for (const unit of units) { try { execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' }) } catch {} }
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
