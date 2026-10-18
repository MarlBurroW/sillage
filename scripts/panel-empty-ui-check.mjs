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

// Les sept états vides sont mesurés dans une instance isolée, sans toucher la production.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-panel-empty-check-'))
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
    // Le dépôt de démo n'a pas d'identité : git prend celle de l'environnement.
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
    await context.addInitScript(() => {
      localStorage.setItem('sillage.locale', 'fr')
      localStorage.setItem('sillage.panelTree', '0')
    })
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
    const template = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
    const created = await context.request.post(`${base}/api/projects/${project.id}/conversations`, {
      data: { agent: template.agent, config: template.config, title: 'Vérifier les états vides' },
    })
    assert.equal(created.status(), 201, await created.text())
    const hero = await created.json()
    // Le journal reste réellement vide ; seule l'absence de dépôt est simulée.
    await context.route('**/git/status', (route) => route.fulfill({ json: { repo: null } }))
    await context.route('**/api/actions', (route) => route.fulfill({ json: [] }))
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${base}/p/${project.id}/c/${hero.id}`)
    return { context, page, errors, hero }
  }


  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 667, height: 320 }]) {
    const { page, context, errors } = await session(viewport, viewport.width < 900)
    await page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
    const panel = page.locator('[data-panel="workspace"]')
    const rail = panel.getByRole('navigation')
    await rail.waitFor()
    const modes = viewport.width === 1440 ? ['docked', 'expanded', 'fullscreen'] : ['default']
    for (const mode of modes) {
      if (mode === 'expanded') await panel.getByRole('button', { name: 'Agrandir le panneau', exact: true }).click()
      if (mode === 'fullscreen') await panel.getByRole('button', { name: 'Afficher l’IDE en plein écran', exact: true }).click()
      for (const tab of ['Fichiers', 'Git', 'Historique', 'Terminaux', 'Actions', 'Sous-agents', 'MCP']) {
        await rail.getByRole('button', { name: tab, exact: true }).click()
        const empty = panel.locator('[data-panel-empty]:visible')
        await empty.waitFor()
        await page.waitForTimeout(250)
        const geometry = await empty.evaluate((el) => {
          const box = el.getBoundingClientRect()
          const content = el.firstElementChild.getBoundingClientRect()
          const pane = el.closest('[data-panel="workspace"]').querySelector('header').getBoundingClientRect()
          return {
            dx: content.x + content.width / 2 - (box.x + box.width / 2),
            dy: content.y + content.height / 2 - (box.y + box.height / 2),
            paneDx: box.x + box.width / 2 - (pane.x + pane.width / 2),
            fits: el.scrollHeight <= el.clientHeight,
            topVisible: content.top >= box.top,
            noHorizontalOverflow: el.scrollWidth <= el.clientWidth,
          }
        })
        assert.ok(Math.abs(geometry.dx) <= 1, `${tab}: centrage horizontal ${JSON.stringify(geometry)}`)
        assert.ok(Math.abs(geometry.paneDx) <= 1, `${tab}: largeur du panneau ${JSON.stringify(geometry)}`)
        if (geometry.fits) assert.ok(Math.abs(geometry.dy) <= 1, `${tab}: centrage vertical ${JSON.stringify(geometry)}`)
        assert.ok(geometry.topVisible && geometry.noHorizontalOverflow, `${tab}: débordement ${JSON.stringify(geometry)}`)
        await page.screenshot({ path: `/var/tmp/sillage-empty-${viewport.width}-${mode}-${tab}.png` })
      }
    }
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Sept états vides vérifiés à ${viewport.width} × ${viewport.height}`)
  }
} finally {
  await browser?.close()
  for (const child of processes.reverse()) child.kill('SIGTERM')
  await delay(400)
  await rm(data, { recursive: true, force: true })
}
