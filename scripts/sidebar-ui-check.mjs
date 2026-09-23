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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
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
  const shots = join(root, 'docs/audits/2026-09-19-sidebar')
  await mkdir(shots, { recursive: true })
  // Une longue liste pour vérifier le défilement, sans toucher à la base réelle.
  await page.route('**/api/conversations', async (route) => {
    const response = await route.fetch()
    const entries = await response.json()
    await route.fulfill({ json: [...entries, ...Array.from({ length: 30 }, (_, i) => ({ ...hero, id: `fixture-${i}`, title: `Session de travail ${i + 1}`, favorite: false, archivedAt: null }))] })
  })
  await page.route('**/api/projects', async (route) => {
    const response = await route.fetch()
    const entries = await response.json()
    await route.fulfill({ json: [...entries, ...Array.from({ length: 40 }, (_, i) => ({ ...project, id: `project-${i}`, name: `Projet ${i + 1}` }))] })
  })
  await page.goto(`${base}/p/${project.id}/c/${hero.id}`)
  const nav = page.getByRole('navigation').filter({ has: page.getByRole('group', { name: 'Suivi des conversations' }) })
  const switcher = page.getByRole('button', { name: 'Changer de projet', exact: true })
  await switcher.waitFor()
  await nav.getByRole('button', { name: /Voir les .* sessions/ }).click()
  await nav.getByRole('link', { name: /Session de travail 30/ }).waitFor()
  const before = await switcher.boundingBox()
  await page.locator('#sidebar-activity-results').evaluate((el) => { el.scrollTop = el.scrollHeight })
  assert.deepEqual(await switcher.boundingBox(), before)
  assert.equal(await nav.getByRole('button', { name: /^\d+ à débloquer$/ }).isVisible(), true)
  await nav.getByRole('button', { name: 'Réduire la liste' }).click()
  assert.equal(await nav.getByRole('link', { name: /Session de travail 30/ }).count(), 0)
  await switcher.click()
  const dialog = page.getByRole('dialog', { name: 'Changer de projet' })
  const search = dialog.getByRole('textbox', { name: 'Rechercher un projet…' })
  await search.fill('atlas')
  await dialog.getByRole('button', { name: 'Épingler Atlas API', exact: true }).click()
  await dialog.getByRole('button', { name: 'Atlas API', exact: true }).click()
  await page.waitForURL(/\/p\/[^/]+\/(c\/new|board)$/)
  await switcher.filter({ hasText: 'Atlas API' }).waitFor()
  await switcher.click()
  await dialog.getByRole('button', { name: 'Nimbus', exact: true }).click()
  await page.waitForURL(`**/c/${hero.id}`)
  await page.reload()
  await switcher.click()
  await dialog.getByRole('button', { name: 'Désépingler Atlas API', exact: true }).waitFor()
  await search.fill('introuvablexyz')
  await dialog.getByRole('status').filter({ hasText: 'Aucun projet trouvé' }).waitFor()
  await search.fill('')
  await page.screenshot({ path: join(shots, 'project-switcher.png') })
  await dialog.getByRole('button', { name: 'Tous les projets', exact: true }).click()
  await nav.getByRole('link', { name: 'Atlas API', exact: true }).waitFor()
  await switcher.click()
  await dialog.getByRole('button', { name: 'Nimbus', exact: true }).click()
  await page.screenshot({ path: join(shots, 'focused-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Ouvrir la navigation', exact: true }).click()
  await switcher.click()
  await dialog.getByRole('textbox').fill('Docs')
  await page.screenshot({ path: join(shots, 'project-switcher-mobile.png') })
  await dialog.getByRole('textbox').press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Ouvrir la navigation', exact: true }).waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.deepEqual(errors, [])
  console.log('OK : navigation projet/session, recherche, épingles persistantes, vue globale, longue liste, activité fixe, mobile.')
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
