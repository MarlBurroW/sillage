import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Vérifie la permission de création sur ordinateur et téléphone, puis la vraie API.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-api-projects-check-'))
const shots = process.env.API_PROJECTS_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-api-projects-shots-')))
const processes = []
let browser
const unit = `sillage-app-api-projects-check-${process.pid}`

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
  await writeFile(config, '[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n')
  const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: join(data, 'web') }
  const server = spawn('systemd-run', ['--user', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--working-directory=${serverDir}`,
    ...Object.entries(env).filter(([key]) => key.startsWith('SILLAGE_') || ['PATH', 'NODE_ENV'].includes(key)).map(([key, value]) => `--setenv=${key}=${value}`),
    process.execPath, '--import', 'tsx', 'src/main.ts'], { stdio: 'pipe' })
  server.diagnostics = ''
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { server.diagnostics += chunk })
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [code] = await once(seed, 'exit')
  assert.equal(code, 0, seed.diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    await page.goto(`${base}/settings/api`)
    await page.getByRole('button', { name: "Créer un jeton d'API", exact: true }).click()
    const permission = page.getByRole('checkbox', { name: /projects:write/ })
    assert.equal(await permission.isChecked(), false)
    await permission.check()
    assert.ok(await permission.isChecked())
    await permission.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, `${name}.png`) })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }
  await page.getByRole('textbox', { name: 'Nom', exact: true }).fill('Création API')
  const created = page.waitForResponse(response => response.url().endsWith('/api/tokens') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Créer le jeton', exact: true }).click()
  const tokenResponse = await created
  assert.equal(tokenResponse.status(), 201, await tokenResponse.text())
  const token = await tokenResponse.json()
  assert.ok(token.token.scopes.includes('projects:write'))
  const payload = { name: 'Projet via API', parentDir: data, directory: 'new-project' }
  const headers = { authorization: `Bearer ${token.secret}` }
  assert.equal((await context.request.post(`${base}/api/v1/projects`, { data: payload })).status(), 401)
  assert.equal((await context.request.post(`${base}/api/projects`, { headers, data: payload })).status(), 403)
  const response = await context.request.post(`${base}/api/v1/projects`, { headers, data: payload })
  assert.equal(response.status(), 201, await response.text())
  const project = await response.json()
  const listed = await (await context.request.get(`${base}/api/v1/projects`, { headers })).json()
  assert.ok(listed.some(entry => entry.id === project.id))
  assert.deepEqual(errors, [])
  console.log(`api-projects-ui-check: ok — captures dans ${shots}`)
} finally {
  await browser?.close()
  execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
