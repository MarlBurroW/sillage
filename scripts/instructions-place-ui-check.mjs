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

// Where instructions live: toolbar icon and label, summary rows in the dialog and the project page, mode change.
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
  const shots = process.env.SILLAGE_UI_SHOTS ?? await mkdtemp(join(tmpdir(), 'sillage-instructions-shots-'))
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
    const conversationUrl = page.url()
    const projectId = new URL(conversationUrl).pathname.split('/')[2]
    const before = await (await context.request.get(`${base}/api/projects/${projectId}/instructions`)).json()

    // The toolbar names the place before any click, and no longer mentions a SILLAGE.md file.
    const button = page.getByRole('button', { name: /^Consignes · / })
    await button.waitFor()
    assert.equal(await button.getAttribute('aria-label'), before.mode === 'sillage' ? 'Consignes · Enregistrées dans Sillage' : `Consignes · ${before.repoFiles[0]?.path ?? 'AGENTS.md'}, dans le dépôt`)
    if (viewport.name === 'wide') {
      await button.hover()
      await page.getByRole('tooltip').first().waitFor()
      const box = await button.boundingBox()
      await page.screenshot({ path: join(shots, 'wide-toolbar.png'), clip: { x: box.x - 260, y: 0, width: 520, height: box.y + box.height + 60 } })
    }
    await button.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /Ce projet/, pressed: true }).waitFor()
    assert.equal(await dialog.getByText('SILLAGE.md').count(), 0)
    await page.screenshot({ path: join(shots, `${viewport.name}-dialog.png`) })

    // The rows choose the layer edited.
    await dialog.getByRole('button', { name: /Tous les projets/ }).click()
    await dialog.getByRole('button', { name: /Tous les projets/, pressed: true }).waitFor()
    await dialog.getByRole('button', { name: /Ce projet/ }).click()

    if (viewport.name === 'wide') {
      // Changing the place goes through its own dialog, then shows everywhere.
      const target = before.mode === 'sillage' ? 'repo' : 'sillage'
      await dialog.getByRole('button', { name: 'Changer', exact: true }).click()
      const change = page.getByRole('dialog', { name: 'Où ranger les consignes de ce projet' })
      await change.getByRole('radio', { name: new RegExp(target === 'repo' ? 'Dans le dépôt' : 'Dans Sillage') }).click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(shots, 'wide-change.png') })
      await change.getByRole('button', { name: 'Appliquer', exact: true }).click()
      await change.waitFor({ state: 'detached' })
      const expected = target === 'sillage' ? 'Enregistrées dans Sillage' : /dans le dépôt$/
      await dialog.getByText(expected).first().waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: target === 'sillage' ? 'Consignes · Enregistrées dans Sillage' : /^Consignes · .*dans le dépôt$/ }).waitFor()

      // Project page: same summary, global row leading to the settings.
      await page.goto(`${base}/p/${projectId}?section=instructions`)
      const card = page.locator('section[aria-label="Consignes"]')
      await card.getByRole('link', { name: 'Voir', exact: true }).waitFor()
      await page.screenshot({ path: join(shots, 'wide-project-page.png') })
      await context.request.patch(`${base}/api/projects/${projectId}/instructions`, { data: { mode: before.mode } })
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log(`Instructions place check passed. Screenshots: ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
