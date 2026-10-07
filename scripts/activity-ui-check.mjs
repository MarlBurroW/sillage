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

// Vrais composants et vraie API, dans une base temporaire. Aucun CLI n'est activé.
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
    // La visionneuse PDF du navigateur n'expose pas le stockage de l'application.
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
  const shots = join(root, 'docs/audits/2026-10-07-activity')
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
  const activity = page.getByRole('group', { name: 'Suivi des conversations', exact: true })
  const total = activity.getByRole('button', { name: /Activité.*4 en cours/ })
  await total.waitFor()
  await activity.getByRole('button', { name: '2 à débloquer', exact: true }).waitFor()
  assert.equal(await activity.getByRole('link').count(), 4)
  await activity.getByRole('button', { name: '+ 2 autres sessions actives', exact: true }).waitFor()
  // L'attente est visible avant les sessions en cours, sans déplier un projet.
  assert.match(await activity.getByRole('link').first().innerText(), /Valider les migrations/)
  await activity.getByRole('link', { name: /Compiler la nouvelle interface/ }).waitFor()
  await page.screenshot({ path: join(shots, 'activity-expanded.png') })
  await activity.getByRole('button', { name: 'Replier l’activité', exact: true }).click()
  await total.waitFor()
  assert.equal(await activity.getByRole('link').count(), 0)
  await total.click()
  const overview = page.getByRole('dialog', { name: 'Activité globale', exact: true })
  await overview.getByRole('region', { name: 'À débloquer', exact: true }).waitFor()
  await overview.getByText('Autre projet', { exact: true }).waitFor()
  assert.equal(await overview.getByRole('link').count(), 6)
  await page.screenshot({ path: join(shots, 'activity-overview.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.screenshot({ path: join(shots, 'activity-overview-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  // Une fin de tour fait baisser le compteur, sans faire disparaître la session.
  pushStatus('activity-a', 'running')
  pushStatus('activity-a', 'idle')
  await overview.getByRole('heading', { name: '3 en cours', exact: true }).waitFor()
  await overview.getByRole('region', { name: 'Viennent de s’arrêter', exact: true }).getByRole('link', { name: /Compiler la nouvelle interface.*Tour terminé/ }).waitFor()
  // Le travail en arrière-plan compte même si le tour principal est au repos.
  pushStatus('activity-a', 'idle', 1)
  await overview.getByRole('heading', { name: '4 en cours', exact: true }).waitFor()
  await overview.getByRole('link', { name: /Compiler la nouvelle interface.*En arrière-plan/ }).waitFor()
  pushStatus('activity-a', 'error')
  await overview.getByRole('region', { name: 'Viennent de s’arrêter', exact: true }).getByRole('link', { name: /Compiler la nouvelle interface.*En erreur/ }).waitFor()
  await overview.getByRole('button', { name: 'À débloquer 2', exact: true }).click()
  assert.equal(await overview.getByRole('link').count(), 2)
  await overview.getByRole('button', { name: 'Non lues 6', exact: true }).click()
  assert.equal(await overview.getByRole('link').count(), 6)
  await overview.getByRole('button', { name: 'Fermer', exact: true }).click()
  // Une nouvelle conversation, lancée depuis un autre client, rejoint le total.
  fixtures.push({ ...fixtures[0], id: 'activity-new', title: 'Session démarrée ailleurs', status: 'running' })
  pushStatus('activity-new', 'running')
  await activity.getByRole('button', { name: /Activité.*4 en cours/ }).waitFor()
  await activity.getByRole('button', { name: 'Voir toute l’activité', exact: true }).click()
  await overview.getByRole('link', { name: /Session démarrée ailleurs/ }).waitFor()
  await page.keyboard.press('Escape')
  await overview.waitFor({ state: 'hidden' })
  assert.equal(await activity.getByRole('button', { name: 'Voir toute l’activité', exact: true }).evaluate((el) => el === document.activeElement), true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Ouvrir la navigation', exact: true }).click()
  await activity.getByRole('button', { name: 'Déplier l’activité', exact: true }).click()
  await page.screenshot({ path: join(shots, 'activity-mobile.png') })
  await activity.getByRole('button', { name: /Activité.*4 en cours/ }).click()
  await overview.getByRole('link', { name: /Session démarrée ailleurs/ }).waitFor()
  await page.screenshot({ path: join(shots, 'activity-overview-mobile.png') })
  const box = await overview.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await overview.getByRole('button', { name: 'Fermer', exact: true }).click()
  // Au repos, l'overview reste accessible et annonce explicitement zéro.
  for (const entry of fixtures) pushStatus(entry.id, 'idle')
  await activity.getByRole('button', { name: /Activité.*0 en cours/ }).waitFor()
  await activity.getByText('Aucune session en cours', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('OK : total global, projets, attentes, repli, détail, statuts temps réel, fins de tour, arrière-plan, nouvelles sessions, non-lus et mobile.')
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
