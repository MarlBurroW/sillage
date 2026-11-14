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

// Real components and API, temporary database. No CLI enabled.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-ui-check-'))
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
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', colorScheme: 'dark', serviceWorkers: 'block' })
  await context.addInitScript((origin) => {
    // Browser PDF viewer does not expose application storage.
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const projects = await (await context.request.get(`${base}/api/projects`)).json()
  const project = projects.find((entry) => entry.name === 'Nimbus')
  const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
  const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const shots = join(data, 'screenshots')
  await mkdir(shots, { recursive: true })
  const atlas = projects.find((entry) => entry.name === 'Atlas API')
  const docs = projects.find((entry) => entry.name === 'Docs')
  const extraProject = { ...project, id: 'extra-project', name: 'Autre projet' }
  const fixtures = [
    { id: 'activity-a', projectId: project.id, title: 'Compiler la nouvelle interface', status: 'running' },
    { id: 'activity-b', projectId: project.id, title: 'Valider les migrations', status: 'awaiting_input' },
    { id: 'activity-c', projectId: atlas.id, title: 'Optimiser les requêtes', status: 'running' },
    { id: 'activity-d', projectId: atlas.id, title: 'Attendre le choix utilisateur', status: 'awaiting_input' },
    { id: 'activity-e', projectId: docs.id, title: 'Documenter les endpoints et revoir les exemples après les retours de l’équipe', status: 'running' },
    { id: 'activity-f', projectId: extraProject.id, title: 'Surveiller le build', status: 'running' },
  ].map((entry) => ({ ...hero, archivedAt: null, favorite: false, lastNotableSeq: 5, lastReadSeq: 0, ...entry }))
  await page.route('**/api/projects', async (route) => route.fulfill({ json: [...projects, extraProject] }))
  await page.route('**/api/conversations', async (route) => route.fulfill({ json: fixtures }))
  let socket
  await page.routeWebSocket('**/api/ws', (ws) => {
    socket = ws
    ws.onMessage((raw) => { if (JSON.parse(String(raw)).t === 'ping') ws.send(JSON.stringify({ t: 'pong' })) })
  })
  const pushStatus = (id, status, background = 0) => socket.send(JSON.stringify({ t: 'status', conversationId: id, status, background, warm: true, loops: 0, lastNotableSeq: 5, metrics: hero.metrics }))
  await page.goto(`${base}/p/${project.id}/board`)
  const rail = page.locator('[data-nav-rail]')
  const activity = rail.locator('[data-nav-space="activity"]')
  // The rail entry carries the totals in its name, and what waits on the user as a badge.
  await rail.getByRole('button', { name: /^Activité — 2 à débloquer · 4 en cours · 6 non lues$/ }).waitFor()
  assert.equal(await activity.locator('.nav-rail-badge').innerText(), '2')
  // Each project's mark shows its own most pressing state: waiting outranks working.
  await rail.locator(`[data-nav-space="project:${project.id}"] .nav-tone-awaiting`).waitFor()
  await rail.locator(`[data-nav-space="project:${docs.id}"] .nav-tone-running`).waitFor()
  await activity.click()
  const column = page.locator('[data-nav-column="activity"]')
  const section = (name) => column.getByRole('region', { name, exact: true })
  const count = (name, expected) => page.waitForFunction(([label, wanted]) => {
    const region = document.querySelector(`[data-nav-column="activity"] section[aria-label="${label}"]`)
    return (region?.querySelectorAll('[data-sidebar-session]').length ?? 0) === wanted
  }, [name, expected])
  await count('À débloquer', 2)
  await count('En cours', 4)
  await count('Non lues', 6)
  // Waiting comes before running, and every row names its project.
  assert.match(await column.locator('[data-sidebar-session]').first().innerText(), /Valider les migrations|Attendre le choix utilisateur/)
  await section('En cours').locator('.sidebar-session-project').filter({ hasText: 'Autre projet' }).waitFor()
  // Activity is a list to pick from: the page stays where it was.
  assert.equal(new URL(page.url()).pathname, `/p/${project.id}/board`)
  await page.screenshot({ path: join(shots, 'activity-column.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.screenshot({ path: join(shots, 'activity-column-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  // Turn completion takes the session out of running work without a reload.
  pushStatus('activity-a', 'running')
  pushStatus('activity-a', 'idle')
  await count('En cours', 3)
  // Background work counts even when the main turn is idle.
  pushStatus('activity-a', 'idle', 1)
  await count('En cours', 4)
  pushStatus('activity-a', 'awaiting_input')
  await count('À débloquer', 3)
  await page.waitForFunction(() => document.querySelector('[data-nav-space="activity"] .nav-rail-badge')?.textContent === '3')
  // A new conversation started by another client joins the list.
  fixtures.push({ ...fixtures[0], id: 'activity-new', title: 'Session démarrée ailleurs', status: 'running' })
  pushStatus('activity-new', 'running')
  await section('En cours').getByText('Session démarrée ailleurs', { exact: true }).waitFor()
  // Phone: the drawer shows the same list beside the rail.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /^Ouvrir la navigation/ }).first().click()
  await column.getByText('Session démarrée ailleurs', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(shots, 'activity-mobile.png') })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  // While idle, the list says so instead of leaving empty headings.
  for (const entry of fixtures) pushStatus(entry.id, 'idle')
  await page.waitForFunction(() => !document.querySelector('[data-nav-column="activity"] section[aria-label="En cours"]') && !document.querySelector('[data-nav-column="activity"] section[aria-label="À débloquer"]'))
  await rail.getByRole('button', { name: /^Activité — \d+ non lues$/ }).waitFor()
  assert.equal(await activity.locator('.nav-rail-badge').count(), 0)
  assert.deepEqual(errors, [])
  console.log('OK: rail totals, project marks, activity column, live status, turn ends, background work, new sessions, unread and phone.')
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}
