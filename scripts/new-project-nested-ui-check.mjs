import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// "New folder" must warn when its parent is already the project, and offer "Existing folder".
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-new-project-nested-check-'))
const shots = process.env.NEW_PROJECT_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-new-project-nested-shots-')))
const processes = []
let browser
const unit = `sillage-app-new-project-nested-check-${process.pid}`

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
  await context.request.patch(`${base}/api/me/settings`, { data: { projectsDir: null } })
  // The devtools/devtools mistake: an existing project chosen as "Projects folder".
  const devtools = join(data, 'devtools')
  await mkdir(devtools)
  await writeFile(join(devtools, 'package.json'), '{}')

  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await context.newPage()
    await page.setViewportSize(viewport)
    await page.goto(`${base}/projects/new`)
    await page.getByLabel('Nom', { exact: true }).fill('devtools')
    await page.getByLabel('Dossier des projets').fill(devtools)
    const warning = page.getByText('ressemble déjà à un projet')
    await warning.waitFor()
    await page.getByText(join(devtools, 'devtools')).waitFor()
    await warning.scrollIntoViewIfNeeded()
    await page.locator('form').screenshot({ path: join(shots, `${label}-warning.png`) })

    // Same name without project markers: still warned, by name.
    await page.getByLabel('Dossier des projets').fill(join(data, 'devtools-copy'))
    await page.getByLabel('Nom du dossier').fill('devtools-copy')
    await page.getByText('dans un dossier du même nom').waitFor()
    // A real parent folder: no warning.
    await page.getByLabel('Dossier des projets').fill(data)
    await page.getByLabel('Nom du dossier').fill('devtools2')
    await delay(600)
    assert.equal(await page.getByText('ressemble déjà à un projet').count(), 0)
    assert.equal(await page.getByText('dans un dossier du même nom').count(), 0)

    await page.getByLabel('Dossier des projets').fill(devtools)
    await page.getByLabel('Nom du dossier').fill('devtools')
    await page.getByRole('button', { name: 'Ajouter ce dossier tel quel' }).click()
    assert.equal(await page.getByLabel('Dossier principal').inputValue(), devtools)
    assert.equal(await page.getByLabel('Nom', { exact: true }).inputValue(), 'devtools')
    await page.locator('form').screenshot({ path: join(shots, `${label}-existing.png`) })
    await page.close()
  }
  console.log(`new-project nested check ok — ${shots}`)
} finally {
  await browser?.close()
  try { execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' }) } catch {}
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
