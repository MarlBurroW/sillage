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

// Search palette using real API and demo data. No CLI enabled.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-palette-check-'))
// Screenshots only on request: `SHOTS=/a/directory node scripts/palette-ui-check.mjs`.
const shots = process.env.SHOTS
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

  if (shots) await mkdir(shots, { recursive: true })
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const projects = await (await context.request.get(`${base}/api/projects`)).json()
  const nimbus = projects.find((entry) => entry.name === 'Nimbus')
  const atlas = projects.find((entry) => entry.name === 'Atlas API')
  const conversations = await (await context.request.get(`${base}/api/projects/${nimbus.id}/conversations`)).json()
  const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
  const skill = await context.request.post(`${base}/api/skill-library`, {
    data: { scope: 'project', projectId: nimbus.id, name: 'forecast-debugging', description: 'Use when a forecast is stale.', body: '' },
  })
  assert.ok(skill.ok(), await skill.text())

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const palette = page.getByRole('dialog', { name: 'Rechercher', exact: true })
  const input = palette.getByRole('combobox')
  const groups = () => palette.getByRole('group').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-labelledby') && document.getElementById(node.getAttribute('aria-labelledby')).innerText.split('\n')[0]))
  const selected = async () => (await palette.locator('[role=option][aria-selected=true]').innerText()).split('\n')[0]
  const search = async (text) => {
    await input.fill(text)
    // Ranking is deferred and files arrive from the server: wait for things to settle.
    await page.waitForTimeout(150)
    await palette.locator('svg.animate-spin').waitFor({ state: 'detached' })
  }

  // The shortcut is listened for only after app mount.
  const open = async (path) => {
    if (path) {
      await page.goto(`${base}${path}`)
      await page.getByRole('button', { name: /^Rechercher/ }).first().waitFor()
    }
    await page.keyboard.press('Control+k')
    await input.waitFor()
  }

  await open(`/p/${nimbus.id}/c/${hero.id}`)

  // Empty input: recent conversations, current project first, excluding the open one.
  assert.equal((await groups())[0], 'Nimbus')
  assert.equal(await palette.getByRole('option', { name: /Add offline caching/ }).count(), 0)

  // All types under their project: conversation-worktree file, skill, tickets.
  await search('forecast')
  assert.deepEqual(await groups(), ['Nimbus'])
  const options = await palette.getByRole('option').allInnerTexts()
  for (const expected of ['forecast-debugging', 'Hourly forecast chart', 'forecast-cache.ts']) {
    assert.ok(options.some((text) => text.includes(expected)), `${expected} absent : ${options.join(' | ')}`)
  }
  // Named entities precede files.
  const kinds = options.map((text) => text.split('\n').at(-1))
  assert.ok(kinds.indexOf('Fichier') > kinds.indexOf('Skill'), kinds.join(', '))
  if (shots) await page.screenshot({ path: join(shots, 'palette-forecast.png') })

  // Project names restrict results; a type lists that type; general items have their own group.
  await search('atlas readme')
  assert.deepEqual(await groups(), ['Atlas API'])
  // An action from another project appears only when named with that project.
  await search('board')
  assert.deepEqual(await groups(), ['Nimbus'])
  await search('docs board')
  assert.deepEqual(await groups(), ['Docs'])
  await search('mcp')
  assert.equal((await groups())[0], 'Général')
  assert.ok((await palette.getByRole('option').allInnerTexts()).some((text) => text.includes('Serveurs MCP')))

  // Tab passe au groupe suivant, Maj+Tab revient.
  await search('readme')
  assert.ok((await groups()).length > 1)
  const first = await selected()
  await page.keyboard.press('Tab')
  assert.notEqual(await palette.locator('[role=option][aria-selected=true]').evaluate((node) => node.closest('[role=group]').getAttribute('aria-labelledby')), await palette.locator('[role=option]').first().evaluate((node) => node.closest('[role=group]').getAttribute('aria-labelledby')))
  await page.keyboard.press('Shift+Tab')
  assert.equal(await selected(), first)

  // A current-project file opens in the conversation panel with editor focus.
  await search('forecast-cache')
  assert.equal(await selected(), 'forecast-cache.ts')
  await page.keyboard.press('Enter')
  await palette.waitFor({ state: 'detached' })
  await page.locator('[data-editor-file="src/lib/forecast-cache.ts"] .cm-content:focus').waitFor()
  assert.equal(new URL(page.url()).pathname, `/p/${nimbus.id}/c/${hero.id}`)

  // Another project’s file opens its home view with the panel showing the file.
  await open()
  await search('atlas readme')
  await page.keyboard.press('Enter')
  await page.locator('[data-panel="workspace"] [data-editor-file="README.md"]').waitFor()
  assert.equal(new URL(page.url()).pathname, `/p/${atlas.id}/c/new`)

  // Expand a group by keyboard: selection moves to the first revealed result.
  await open(`/p/${nimbus.id}/c/${hero.id}`)
  await search('nimbus')
  const rows = await palette.getByRole('option').allInnerTexts()
  const more = rows.findIndex((text) => text.includes('de plus'))
  assert.ok(more > 0, rows.join(' | '))
  for (let index = 0; index < more; index++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  assert.ok((await palette.getByRole('option').count()) > rows.length)
  assert.equal(await palette.getByRole('option', { name: /de plus/ }).count(), 0)

  // A command executes in place.
  await search('thème sombre')
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')

  // Phone: fullscreen, close button, no overflow.
  await page.setViewportSize({ width: 390, height: 844 })
  await open()
  await search('forecast')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const box = await palette.boundingBox()
  assert.equal(Math.round(box.width), 390)
  if (shots) await page.screenshot({ path: join(shots, 'palette-mobile.png') })
  await palette.getByRole('button', { name: 'Fermer la recherche', exact: true }).click()
  await palette.waitFor({ state: 'detached' })

  assert.deepEqual(errors, [])
  console.log(`OK : récents, groupes par projet, tous les types, restriction par projet et par type, Tab, fichiers ouverts dans le bon panneau, dépliage, commande, téléphone${shots ? ` ; captures dans ${shots}` : ''}`)
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
