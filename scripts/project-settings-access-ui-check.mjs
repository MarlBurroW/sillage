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

// Ways to a project's settings: the column line, the column mark and the rail's context menu.
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
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok'].map(agent => `[agents.${agent}]\nenabled = false\n`).join(''))
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
  const shots = process.env.SILLAGE_UI_SHOTS ?? await mkdtemp(join(tmpdir(), 'sillage-settings-shots-'))
  await mkdir(shots, { recursive: true })

  for (const viewport of [{ name: 'wide', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block', hasTouch: viewport.name === 'phone' })
    await context.addInitScript(() => { localStorage.setItem('sillage.locale', 'fr'); localStorage.setItem('sillage.theme', 'dark') })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(12000)
    await page.goto(base)
    await page.getByRole('textbox', { name: "Nom d'utilisateur", exact: true }).fill('alex')
    await page.getByRole('textbox', { name: 'Mot de passe', exact: true }).fill('sillage-demo')
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
    await page.waitForURL(/\/p\/[^/]+\/c\/[^/]+$/)
    const projectId = new URL(page.url()).pathname.split('/')[2]
    const column = page.locator('[data-nav-column]')
    if (viewport.name === 'phone') {
      await page.getByRole('button', { name: /navigation|menu/i }).first().click()
      await column.waitFor()
    }

    // The line: one click from the column, and marked while the page is shown.
    const line = column.getByRole('link', { name: 'Réglages', exact: true })
    await line.click()
    await page.waitForURL(new RegExp(`/p/${projectId}$`))
    if (viewport.name === 'phone') {
      await page.getByRole('button', { name: /navigation|menu/i }).first().click()
      await column.waitFor()
    }
    await column.locator('a[aria-current="page"]', { hasText: 'Réglages' }).waitFor({ timeout: 4000 })
    await page.screenshot({ path: join(shots, `${viewport.name}-line.png`) })

    if (viewport.name === 'wide') {
      // The mark opens the same page from a conversation.
      await page.goBack()
      await page.waitForURL(/\/c\/[^/]+$/)
      assert.equal(await line.getAttribute('aria-current'), null)
      await column.getByRole('link', { name: 'Réglages du projet', exact: true }).click()
      await page.waitForURL(new RegExp(`/p/${projectId}$`))

      // The rail's context menu reaches it while another space fills the column.
      await page.goBack()
      await page.locator('[data-nav-rail]').getByRole('button', { name: /^Activité/ }).first().click()
      await page.locator(`[data-nav-space="project:${projectId}"]`).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Réglages du projet' }).click()
      await page.waitForURL(new RegExp(`/p/${projectId}$`))
      await column.getByRole('link', { name: 'Réglages', exact: true }).waitFor()
      await page.screenshot({ path: join(shots, 'wide-rail-menu.png') })
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log(`Project settings access check passed. Screenshots: ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
