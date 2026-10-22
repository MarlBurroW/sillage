import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Demo turn checkpoints: real server/git, temporary database. `checkpoint-demo.ts`
// plays a turn without an agent, including snapshots and files.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-checkpoints-check-'))
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
  const demo = run(['--import', 'tsx', 'src/cli/checkpoint-demo.ts'], serverDir, env)
  const [demoCode] = await once(demo, 'exit')
  assert.equal(demoCode, 0, demo.diagnostics)
  const turn = JSON.parse(demo.diagnostics.trim().split('\n').at(-1))
  assert.equal(turn.files, 3)
  assert.equal(existsSync(join(turn.cwd, 'CHANGELOG.md')), true)
  assert.equal(existsSync(join(turn.cwd, 'src/lib/forecast.ts')), false)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })

  const session = async (viewport, mobile) => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${base}/p/${project.id}/c/${turn.conversationId}`)
    return { context, page, errors, project }
  }

  // Desktop: marker below turn, filtered Git tab, diff, restoration.
  const { page, errors, project } = await session({ width: 1440, height: 900 }, false)
  const strip = page.locator(`[data-checkpoint="${turn.key}"]`)
  await strip.scrollIntoViewIfNeeded()
  await strip.getByText('3 fichiers changés par ce tour', { exact: true }).waitFor()
  console.log('OK : le repère de fin de tour annonce les fichiers changés.')

  await strip.getByTitle('Voir ce que ce tour a changé dans le dépôt', { exact: true }).click()
  const panel = page.locator('[data-panel="workspace"]')
  await panel.getByText('Changements du tour', { exact: true }).waitFor()
  await panel.getByText('Add a CHANGELOG entry', { exact: false }).waitFor()
  const rows = panel.locator('.group\\/change')
  assert.equal(await rows.count(), 3, 'Trois fichiers listés')
  const paths = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-path')).sort())
  assert.deepEqual(paths, ['CHANGELOG.md', 'README.md', 'src/lib/forecast.ts'])

  // File diff read from snapshots.
  const readmeRow = panel.locator('.group\\/change[data-path="README.md"]')
  await readmeRow.getByRole('button').first().click()
  await panel.locator('table').first().waitFor()
  await panel.getByText('offline cache', { exact: false }).first().waitFor()
  console.log('OK : onglet Git filtré sur le tour, diff lisible.')
  await page.screenshot({ path: '/tmp/sillage-checkpoints-desktop.png' })

  // Return to repository: ordinary Git tab returns.
  await panel.getByRole('button', { name: 'Retour au dépôt', exact: true }).click()
  await panel.getByText('Changements du tour', { exact: true }).waitFor({ state: 'hidden' })

  // Restore from thread after confirmation.
  await strip.getByRole('button', { name: "Revenir à l'état d'avant ce tour", exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText("Revenir à l'état d'avant ce tour ?", { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Revenir en arrière', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByText(/Workspace ramené en arrière : \d+ fichiers réécrits, \d+ supprimés/).waitFor()
  await strip.getByText("Workspace ramené à l'état d'avant ce tour", { exact: true }).waitFor()
  assert.equal(existsSync(join(turn.cwd, 'CHANGELOG.md')), false, 'Le fichier créé par le tour est retiré')
  assert.equal(existsSync(join(turn.cwd, 'src/lib/forecast.ts')), true, 'Le fichier supprimé par le tour est revenu')
  assert.doesNotMatch(await readFile(join(turn.cwd, 'README.md'), 'utf8'), /offline cache/, 'Le fichier modifié est revenu')
  console.log('OK : workspace ramené à l’état d’avant le tour.')
  assert.deepEqual(errors, [])

  // Phone: marker and filtered panel fit 390 px.
  const phone = await session({ width: 390, height: 844 }, true)
  const phoneStrip = phone.page.locator(`[data-checkpoint="${turn.key}"]`)
  await phoneStrip.scrollIntoViewIfNeeded()
  await phoneStrip.getByTitle('Voir ce que ce tour a changé dans le dépôt', { exact: true }).click()
  const mobilePanel = phone.page.locator('[data-panel="workspace"]')
  await mobilePanel.getByText('Changements du tour', { exact: true }).waitFor()
  assert.equal(await mobilePanel.locator('.group\\/change').count(), 3)
  const width = await mobilePanel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
  assert.ok(width, 'Pas de défilement horizontal au téléphone')
  await phone.page.screenshot({ path: '/tmp/sillage-checkpoints-phone.png' })
  assert.deepEqual(phone.errors, [])
  void project

  console.log('OK : points de reprise vérifiés sur grand écran et au téléphone.')
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await delay(200)
  await rm(data, { recursive: true, force: true })
}
