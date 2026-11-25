import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Agent tool families: the admin's instance default under Settings › Agent tools, and the
// owner's per-project override in the project's Agents tab. Real server and web on a temporary
// demo database.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
const data = await mkdtemp(join(tmpdir(), 'sillage-agent-tools-check-'))
const shots = process.env.SILLAGE_CHECK_SHOTS ?? '/var/tmp/sillage-agent-tools-check'
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
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  let server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  const projects = await (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok
  assert.ok(projects)
  await mkdir(shots, { recursive: true })

  browser = await chromium.launch()
  const errors = []
  let first = true
  for (const [name, viewport, mobile] of [['desktop', { width: 1440, height: 1000 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', colorScheme: theme, serviceWorkers: 'block' })
      const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
      assert.ok(login.ok())
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(`${name}/${theme}: ${error.message}`))

      await page.goto(`${base}/settings/outils-agents`)
      const toggle = page.getByRole('switch', { name: 'Navigateur' })
      await toggle.waitFor()
      if (first) {
        assert.equal(await toggle.getAttribute('aria-checked'), 'false')
        await toggle.click()
        await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Navigateur"]')?.getAttribute('aria-checked') === 'true')
        const settings = await (await context.request.get(`${base}/api/settings`)).json()
        assert.deepEqual(settings.agentTools, { browser: true })
      }
      // Captured settled: a pending save dims the switch.
      await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="Navigateur"]')?.matches(':disabled'))
      // Switches fade between states over 150 ms once the settings arrive.
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, `settings-${name}-${theme}.png`) })

      const list = await (await context.request.get(`${base}/api/projects`)).json()
      const project = list.find((entry) => entry.isOwner)
      await page.goto(`${base}/p/${project.id}?section=agents`)
      const select = page.getByRole('combobox', { name: 'Navigateur' })
      await select.waitFor()
      // Disabled until the instance default is known, so the inherited label is never a guess.
      await page.waitForFunction(() => !document.querySelector('[role="combobox"][aria-label="Navigateur"]')?.matches(':disabled'))
      if (first) {
        assert.match(await select.innerText(), /Par défaut \(activé\)/)
        await select.click()
        await page.getByRole('option', { name: 'Désactivé' }).click()
        await page.waitForFunction(() => /Désactivé/.test(document.querySelector('[role="combobox"][aria-label="Navigateur"]')?.textContent ?? ''))
        let after = await (await context.request.get(`${base}/api/projects`)).json()
        assert.deepEqual(after.find((entry) => entry.id === project.id).agentTools, { browser: false })
        // A built-in family: on by default, turned off for this project only.
        const board = page.getByRole('combobox', { name: 'Board' })
        assert.match(await board.innerText(), /Par défaut \(activé\)/)
        await board.click()
        await page.getByRole('option', { name: 'Désactivé' }).click()
        await page.waitForFunction(() => /Désactivé/.test(document.querySelector('[role="combobox"][aria-label="Board"]')?.textContent ?? ''))
        after = await (await context.request.get(`${base}/api/projects`)).json()
        assert.deepEqual(after.find((entry) => entry.id === project.id).agentTools, { browser: false, board: false })
        await page.getByRole('switch', { name: 'Agir sur mes autres projets' }).waitFor()
        first = false
      }
      await select.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, `project-${name}-${theme}.png`) })
      await context.close()
    }
  }
  assert.deepEqual(errors, [])
  console.log(`ok — captures in ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
