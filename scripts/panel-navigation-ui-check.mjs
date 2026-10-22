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

// Session navigation must preserve panel state, including clicks on worktree labels.
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

  const session = async (viewport, mobile) => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
    const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
    const rooted = conversations.find((entry) => entry.title === 'Refactor settings storage')
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    return { context, page, errors, project, hero, rooted }
  }
  const header = (page) => page.locator('header').filter({ has: page.getByRole('button', { name: /^(Ouvrir|Fermer) le panneau$/ }) })

  const worktreeBar = (page) => page.getByRole('region', { name: 'Worktree de la conversation' })


  for (const width of [1440, 390]) {
    const { page, context, errors, project, hero, rooted } = await session({ width, height: 900 }, width < 700)
    await page.goto(`${base}/p/${project.id}/c/${rooted.id}`)
    const panel = page.locator('[data-panel="workspace"]')
    await header(page).getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
    await panel.getByRole('button', { name: 'Fermer le panneau', exact: true }).click()
    await panel.waitFor({ state: 'detached' })

    const navigate = async (id, tag = false) => {
      const link = page.locator(`a[href="/p/${project.id}/c/${id}"]`).filter({ has: page.getByText(tag ? 'feat/offline-cache' : rooted.title, { exact: true }) }).first()
      if (width < 700) await page.locator('[data-navigation-trigger]').click()
      await (tag ? link.getByRole('note') : link).click()
      await page.waitForURL(`**/c/${id}`)
    }
    for (let i = 0; i < 2; i++) {
      await navigate(hero.id, true)
      await page.waitForTimeout(350)
      assert.equal(await page.evaluate(() => localStorage.getItem('sillage.panelOpen')), '0', 'Navigating through the worktree label must preserve the closed panel')
      assert.equal(await panel.count(), 0)
      await navigate(rooted.id)
    }
    await navigate(hero.id, true)
    await worktreeBar(page).getByRole('button', { name: 'Voir le Git', exact: true }).click()
    await panel.waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('sillage.panelOpen')), '1')
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Panel navigation verified at ${width}px`)
  }
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await delay(200)
  await rm(data, { recursive: true, force: true })
}
