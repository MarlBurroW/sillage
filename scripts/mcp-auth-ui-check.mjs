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

// MCP registry Bearer helper: pasted token, stored secret, and reopening an existing header.
// Server and Desktop each use a disposable database; no real agent is launched.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-mcp-auth-check-'))
const shots = process.env.MCP_AUTH_SHOTS ?? await mkdtemp(join(tmpdir(), 'sillage-mcp-auth-shots-'))
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
  const unit = `sillage-app-mcp-auth-${name}-${process.pid}`
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
async function exercise(context, base, profile) {
  page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.request.patch(`${base}/api/me/settings`, { data: { onboarding: { pending: false } } })
  assert.ok((await context.request.put(`${base}/api/secrets`, { data: { name: `${profile.toUpperCase()}_TOKEN`, value: 'never-shown' } })).ok())
  const name = `remote-${profile}`
  for (const [label, viewport] of [['wide', { width: 1920, height: 1080 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    await page.goto(`${base}/settings/mcp`)
    await page.getByRole('button', { name: 'Déclarer un serveur' }).first().click()
    await page.getByRole('textbox', { name: 'Nom', exact: true }).fill(`${name}-${label}`)
    await page.getByRole('combobox', { name: 'Transport' }).click()
    await page.getByRole('option', { name: 'HTTP', exact: true }).click()
    await page.getByRole('textbox', { name: 'URL' }).fill('https://mcp.example.com/mcp')
    await page.getByRole('combobox', { name: 'Authentification' }).click()
    await page.getByRole('option', { name: 'Jeton Bearer' }).click()
    // A stored secret exists: pasting is the explicit second choice.
    await page.getByRole('combobox', { name: 'Jeton', exact: true }).click()
    await page.getByRole('option', { name: 'Coller un jeton…' }).click()
    await page.getByLabel('Valeur du jeton', { exact: true }).fill('pasted-token')
    await page.screenshot({ path: join(shots, `${profile}-${label}-bearer.png`), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    const created = page.waitForResponse(response => response.url().endsWith('/api/mcp/servers') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Déclarer le serveur' }).click()
    const server = await (await created).json()
    assert.deepEqual(server.transport.headers, { Authorization: 'Bearer pasted-token' })
  }

  // Reopen: the header comes back in the dedicated field, then switches to the stored secret.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${base}/settings/mcp`)
  const card = page.locator('div', { has: page.getByText(`${name}-wide`, { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Modifier' }) }).last()
  await card.getByRole('button', { name: 'Modifier' }).click()
  assert.equal(await page.getByLabel('Valeur du jeton', { exact: true }).inputValue(), 'pasted-token')
  assert.equal(await page.getByRole('textbox', { name: 'En-tête' }).count(), 0)
  await page.getByRole('combobox', { name: 'Jeton', exact: true }).click()
  await page.getByRole('option', { name: `${profile.toUpperCase()}_TOKEN` }).click()
  await page.screenshot({ path: join(shots, `${profile}-secret.png`), fullPage: true })
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH')
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  const patched = await (await saved).json()
  assert.deepEqual(patched.transport.headers, { Authorization: `Bearer {{secret.${profile.toUpperCase()}_TOKEN}}` })
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
  console.log(`mcp-auth-ui-check: ok — captures in ${shots}`)
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
