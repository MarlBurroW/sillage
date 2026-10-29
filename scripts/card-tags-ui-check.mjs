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

// Card tags and the session-card link: Server/Desktop, desktop and phone.
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

function run(args, cwd, env, stdio = 'pipe', executable = process.execPath) {
  const child = spawn(executable, args, { cwd, env, stdio })
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
  // Desktop serves the build on its own port: origin checks reject Vite.
  const build = run(['--filter', '@sillage/web', 'build'], root, { ...process.env, NODE_ENV: 'production' }, 'pipe', 'pnpm')
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const profile of ['server', 'desktop']) {
    const apiPort = await freePort()
    const webPort = await freePort()
    const config = join(data, `${profile}.toml`)
    await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n')
    const env = { ...process.env, NODE_ENV: 'development', SILLAGE_CONFIG: config,
      SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1',
      SILLAGE_DATA_DIR: join(data, profile), SILLAGE_WEB_ROOT: profile === 'desktop' ? join(webDir, 'dist') : join(data, 'web') }
    delete env.SILLAGE_PROFILE
    delete env.SILLAGE_HANDSHAKE_FD
    const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
    const [seedCode] = await once(seed, 'exit')
    assert.equal(seedCode, 0, seed.diagnostics)
    const serverEnv = profile === 'desktop' ? { ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3' } : env
    const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, serverEnv, ['pipe', 'pipe', 'pipe', 'pipe'])
    const handshake = profile === 'desktop' ? new Promise(resolve => {
      let output = ''
      server.stdio[3].on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output)) })
    }) : null
    const base = `http://127.0.0.1:${profile === 'desktop' ? apiPort : webPort}`
    await ready(`http://127.0.0.1:${apiPort}/api/health`, server)
    if (profile === 'server') {
      const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
      await ready(base, vite)
    }
    for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block' })
      await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
      if (handshake) {
        const { session } = await handshake
        await context.addCookies([{ name: 'sillage_session', value: session, url: base, httpOnly: true, sameSite: 'Lax' }])
      } else assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
      const projects = await (await context.request.get(`${base}/api/projects`)).json()
      const project = projects.find(p => p.name === 'Nimbus')
      const cards = await (await context.request.get(`${base}/api/projects/${project.id}/cards`)).json()
      const card = number => cards.find(c => c.number === number)
      const sessions = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
      const free = sessions.find(s => !s.card && !s.archivedAt && !s.scheduleId)
      assert.ok(free, 'demo seed has a session without a card')
      const phone = size === 'phone'
      const tagName = `${profile}-${size}`
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const board = `${base}/p/${project.id}/board`

      // Tag a card from its detail: typing a new name creates the tag and applies it at once.
      await page.goto(`${board}?carte=1`)
      const tags = page.getByRole('region', { name: 'Tags', exact: true })
      // Earlier runs on the same server already tagged the card.
      await tags.getByRole('button', { name: /^(Ajouter|Modifier) les tags$|^Ajouter des tags$/ }).click()
      await page.getByLabel('Chercher ou créer un tag').fill(tagName)
      await page.getByRole('button', { name: `Créer « ${tagName} »` }).click()
      await tags.getByText(tagName, { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      const after = await (await context.request.get(`${base}/api/projects/${project.id}/cards`)).json()
      assert.ok(after.find(c => c.number === 1).tags.some(tag => tag.name === tagName))
      await page.screenshot({ path: `/var/tmp/sillage-tags-card-${profile}-${size}.png` })
      await page.keyboard.press('Escape')
      await page.goto(board)

      // The tile shows the chip, and the filter keeps only tagged cards.
      await page.locator('[data-card-tile="1"]').getByText(tagName, { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Filtrer par tag' }).click()
      await page.getByRole('menuitemcheckbox', { name: new RegExp(`^${tagName}`) }).click()
      await page.keyboard.press('Escape')
      if (!phone) {
        await page.waitForFunction(() => document.querySelectorAll('[data-card-tile]').length === 1)
        await page.screenshot({ path: `/var/tmp/sillage-tags-board-${profile}-${size}.png` })
      }
      await page.getByRole('button', { name: 'Filtrer par tag' }).click()
      await page.getByRole('menuitem', { name: 'Tags du board' }).click()
      const dialog = page.getByRole('dialog', { name: 'Tags du board' })
      await dialog.getByRole('switch', { name: 'Les agents peuvent créer des tags' }).waitFor()
      assert.equal(await dialog.getByRole('switch').getAttribute('aria-checked'), 'true')
      await dialog.getByText('1 carte(s)').first().waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: `/var/tmp/sillage-tags-dialog-${profile}-${size}.png` })
      await dialog.getByRole('button', { name: 'Fermer' }).click()

      // A session started outside the board is linked from its toolbar; the card opens in the panel.
      await page.goto(`${base}/p/${project.id}/c/${free.id}`)
      await page.getByRole('button', { name: 'Lier à une carte' }).click()
      const picker = page.getByRole('dialog', { name: 'Lier à une carte' })
      await picker.getByLabel('Chercher par numéro, titre ou tag').fill(tagName)
      await picker.getByRole('button', { name: new RegExp(`^#1 `) }).click()
      const panel = page.locator('[data-panel="workspace"]')
      await panel.getByRole('heading', { name: card(1).title }).waitFor()
      await panel.getByText('Cette session travaille sur cette carte.').waitFor()
      const linked = await (await context.request.get(`${base}/api/conversations/${free.id}`)).json()
      assert.equal(linked.card?.number, 1)
      await page.screenshot({ path: `/var/tmp/sillage-tags-session-${profile}-${size}.png` })

      // The header names the card next to the project; the toolbar toggles the panel tab.
      // Phones show the panel full screen over the toolbar: it closes from its own button there.
      if (phone) await panel.getByRole('button', { name: 'Fermer le panneau' }).click()
      else await page.getByRole('button', { name: 'Masquer la carte #1' }).click()
      await panel.waitFor({ state: 'detached' })
      const chip = page.locator('.sg-conversation-heading').getByRole('button', { name: /#1/ })
      await chip.getByText(card(1).title).waitFor()
      if (!phone) {
        // The session row keeps the card number visible without hovering.
        await page.locator(`[data-sidebar-session="${free.id}"] .sidebar-session-card`).getByText('#1', { exact: true }).waitFor()
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: `/var/tmp/sillage-tags-header-${profile}-${size}.png` })
      await chip.click()
      await panel.getByRole('heading', { name: card(1).title }).waitFor()

      // Detaching from the panel leaves an ordinary session again.
      await panel.getByRole('button', { name: 'Détacher' }).click()
      await page.getByRole('button', { name: 'Lier à une carte' }).waitFor()
      assert.equal((await (await context.request.get(`${base}/api/conversations/${free.id}`)).json()).card, null)

      assert.deepEqual(errors, [])
      await context.close()
      console.log(`OK : ${profile}, ${size}, tag créé et filtré, catalogue, session liée, en-tête, panneau, détachement.`)
    }
  }
} finally {
  await browser?.close()
  await Promise.all(processes.map(async child => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}
