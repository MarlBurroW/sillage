import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Conversation header branch/worktree on demo: real server/git. The “offline cache”
// task runs in a worktree with uncommitted changes; other threads use project root
// on main.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-workspace-label-check-'))
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
  for (let i = 0; i < 300; i++) {
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
    GIT_AUTHOR_NAME: 'Alex Demo',
    GIT_AUTHOR_EMAIL: 'alex@example.test',
    GIT_COMMITTER_NAME: 'Alex Demo',
    GIT_COMMITTER_EMAIL: 'alex@example.test',
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
  const shots = process.env.SHOTS_DIR ?? data

  const session = async (viewport, mobile) => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
    const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
    const rooted = conversations.find((entry) => !entry.worktreeId)
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    return { context, page, errors, project, hero, rooted }
  }
  const header = (page) => page.locator('header').filter({ has: page.getByRole('button', { name: /^(Ouvrir|Fermer) le panneau$/ }) })

  const worktreeBar = (page) => page.getByRole('region', { name: 'Worktree de la conversation' })

  // Desktop worktree thread: branch, uncommitted-change status, click opens Git tab.
  const desk = await session({ width: 1440, height: 900 }, false)
  await desk.page.goto(`${base}/p/${desk.project.id}/c/${desk.hero.id}`)
  const label = worktreeBar(desk.page).getByText('feat/offline-cache', { exact: true })
  await label.waitFor()
  assert.equal((await label.innerText()).trim(), 'feat/offline-cache', 'Le nom du worktree n’est pas répété quand il vaut la branche')
  await desk.page.screenshot({ path: join(shots, 'workspace-label-desktop.png'), clip: { x: 0, y: 0, width: 1440, height: 120 } })
  await worktreeBar(desk.page).getByRole('button', { name: 'Voir le Git' }).click()
  const panel = desk.page.locator('[data-panel="workspace"]')
  await panel.getByRole('button', { name: /^Espace de travail/ }).waitFor()
  console.log('OK : branche du worktree affichée, onglet Git ouvert au clic.')

  // Project-root thread: main-tree branch.
  await desk.page.goto(`${base}/p/${desk.project.id}/c/${desk.rooted.id}`)
  await header(desk.page).getByRole('button', { name: /^Dossier du projet · Branche main/ }).waitFor()
  console.log('OK : branche de l’arbre principal affichée à la racine.')
  assert.deepEqual(desk.errors, [])

  // Phone: project name stays complete, branch truncates, no overflow.
  const phone = await session({ width: 390, height: 844 }, true)
  await phone.page.goto(`${base}/p/${phone.project.id}/c/${phone.hero.id}`)
  const phoneHeader = header(phone.page)
  const phoneLabel = worktreeBar(phone.page).getByText('feat/offline-cache', { exact: true })
  await phoneLabel.waitFor()
  const projectLink = phoneHeader.getByRole('link', { name: 'Nimbus', exact: true })
  const clipped = await projectLink.evaluate((node) => node.scrollWidth > node.clientWidth)
  assert.ok(!clipped, 'Le nom du projet n’est pas tronqué')
  const headerBox = await phoneHeader.boundingBox()
  const labelBox = await phoneLabel.boundingBox()
  assert.ok(labelBox.x + labelBox.width <= headerBox.x + headerBox.width, 'La branche reste dans l’en-tête')
  assert.ok(await phoneHeader.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'Pas de débordement horizontal')
  await phone.page.screenshot({ path: join(shots, 'workspace-label-phone.png'), clip: { x: 0, y: 0, width: 390, height: 120 } })
  assert.deepEqual(phone.errors, [])

  // Worktree deleted outside Sillage: bar reports it after git cache refresh.
  const worktrees = await (await desk.context.request.get(`${base}/api/projects/${desk.project.id}/worktrees`)).json()
  const offline = worktrees.find((entry) => entry.name === 'feat/offline-cache')
  await rm(offline.path, { recursive: true, force: true })
  for (let i = 0; i < 40; i++) {
    const status = await (await desk.context.request.get(`${base}/api/projects/${desk.project.id}/worktrees/status`)).json()
    if (status.worktrees.find((entry) => entry.id === offline.id)?.state === 'missing') break
    await delay(1000)
  }
  await desk.page.goto(`${base}/p/${desk.project.id}/c/${desk.hero.id}`)
  await worktreeBar(desk.page).getByText('Introuvable', { exact: true }).waitFor()
  console.log('OK : worktree disparu signalé.')

  console.log('OK : branche et worktree de l’en-tête vérifiés sur grand écran et au téléphone.')
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await delay(200)
  await rm(data, { recursive: true, force: true })
}
