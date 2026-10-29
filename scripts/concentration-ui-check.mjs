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

// Focus mode: real shell and thread, isolated database, Server and Desktop profiles.
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

const shots = '/var/tmp/sillage-concentration-shots'
await mkdir(shots, { recursive: true })
try {
  // Desktop serves its own web build; the shortcut is for an already checked local build.
  if (!process.env.SILLAGE_SKIP_BUILD) {
    const build = run(['--filter', '@sillage/web', 'build'], root, { ...process.env, NODE_ENV: 'production' }, 'pipe', 'pnpm')
    const [code] = await once(build, 'exit')
    assert.equal(code, 0, build.diagnostics)
  }
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
    for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }], ['small-phone', { width: 320, height: 700 }]]) {
      const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block', hasTouch: size !== 'desktop', isMobile: size !== 'desktop' })
      await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
      if (handshake) {
        const { session } = await handshake
        await context.addCookies([{ name: 'sillage_session', value: session, url: base, httpOnly: true, sameSite: 'Lax' }])
      } else assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
      const projects = await (await context.request.get(`${base}/api/projects`)).json()
      const project = projects.find(p => p.name === 'Nimbus')
      const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
      const hero = conversations.find(c => c.title === 'Add offline caching for forecasts')
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      // No CLI process: only the settings catalog is stubbed; the thread and preferences are real.
      await page.route('**/api/agents/*/models*', route => route.fulfill({ json: {
        models: [{ value: 'test', displayName: 'Test model', description: '', hint: null, isDefault: true, efforts: [{ value: 'high', label: 'High' }], defaultEffort: 'high' }],
        modes: [], account: null, fetchedAt: Date.now(),
      } }))
      await page.goto(`${base}/p/${project.id}/c/${hero.id}`)
      const enter = () => page.getByRole('button', { name: 'Activer le mode concentration', exact: true })
      const exit = () => page.getByRole('button', { name: 'Quitter le mode concentration', exact: true })
      const composer = page.locator('textarea').last()
      await enter().waitFor()
      await composer.fill('Brouillon conservé pendant la lecture')
      // An open docked panel must return after the temporary overlays are closed.
      await page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
      const panel = page.locator('[data-panel="workspace"]')
      await panel.waitFor()
      if (size !== 'desktop') {
        await panel.getByRole('button', { name: 'Fermer le panneau', exact: true }).click()
        await panel.waitFor({ state: 'hidden' })
      }
      const preferences = await page.evaluate(() => [localStorage.getItem('sillage.panelOpen'), localStorage.getItem('sillage.sidebarHidden')])
      await enter().click()
      await exit().waitFor()
      await panel.waitFor({ state: 'hidden' })
      assert.equal(await composer.inputValue(), 'Brouillon conservé pendant la lecture')
      assert.equal(await page.locator('aside[aria-label]').first().getAttribute('inert'), '')
      assert.equal(await page.getByRole('region', { name: 'Worktree de la conversation' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).isVisible(), false)
      // Only Add, Settings and Send at rest.
      assert.equal(await page.locator('form button:visible').count(), 3)
      await page.getByRole('button', { name: 'Ajouter au message', exact: true }).click()
      await page.getByRole('button', { name: 'Dicter un message', exact: true }).waitFor()
      await page.screenshot({ path: join(shots, `${profile}-${size}-insert.png`) })
      await page.keyboard.press('Escape')
      await page.locator('form button').filter({ has: page.locator('svg.lucide-sliders-horizontal') }).click()
      await page.locator('[data-settings-heading]').filter({ hasText: 'Réglages de la conversation' }).waitFor()
      await page.screenshot({ path: join(shots, `${profile}-${size}-settings.png`) })
      await page.keyboard.press('Escape')
      // A file picker still opens from the compact insertion surface.
      await page.getByRole('button', { name: 'Ajouter au message', exact: true }).click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Joindre un fichier', exact: true }).click()
      await chooser
      const group = page.locator('[data-tool-sequence]').first()
      if (await group.count()) {
        await group.scrollIntoViewIfNeeded()
        assert.equal(await group.getAttribute('data-folded'), 'true')
        await group.locator('button').first().click()
        assert.equal(await group.getAttribute('data-folded'), 'false')
        await group.locator('button').first().click()
      }
      // Thread links open an overlay without changing the reading column or saved layout.
      const thread = page.locator('.sg-conversation-content')
      const beforeWidth = (await thread.boundingBox()).width
      const link = page.locator('[data-sg-path="src/lib/forecast-cache.ts"]').first()
      if (await link.count()) {
        await link.click()
        await panel.waitFor()
        assert.equal((await thread.boundingBox()).width, beforeWidth)
        await panel.getByRole('button', { name: 'Fermer le panneau', exact: true }).click()
        await panel.waitFor({ state: 'hidden' })
      }
      await composer.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, `${profile}-${size}.png`) })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      assert.deepEqual(await page.evaluate(() => [localStorage.getItem('sillage.panelOpen'), localStorage.getItem('sillage.sidebarHidden')]), preferences)
      // Preserve the topmost reading marker, including a partly visible message/tool.
      const anchor = await page.locator('.sg-conversation-content').evaluate(thread => {
        const viewport = thread.closest('.fade-bottom').getBoundingClientRect()
        const node = [...thread.querySelectorAll('[data-seq], [data-tool-id], [data-tool-sequence][data-folded="true"]')]
          .find(node => { const r = node.getBoundingClientRect(); return r.height && r.bottom > viewport.top && r.top < viewport.bottom })
        if (!node) return null
        const key = node.hasAttribute('data-seq') ? 'data-seq' : node.hasAttribute('data-tool-id') ? 'data-tool-id' : 'data-thread-anchor'
        return { selector: `[${key}="${CSS.escape(node.getAttribute(key))}"]`, top: node.getBoundingClientRect().top - viewport.top }
      })
      await exit().click()
      if (anchor) {
        await delay(350)
        const top = await page.locator(`.sg-conversation-content ${anchor.selector}`).evaluate(node => node.getBoundingClientRect().top - node.closest('.fade-bottom').getBoundingClientRect().top)
        assert.ok(Math.abs(top - anchor.top) < 12, `Reading anchor moved: ${top - anchor.top}px`)
      }
      assert.equal(await composer.inputValue(), 'Brouillon conservé pendant la lecture')
      if (size === 'desktop') {
        await panel.waitFor()
        await panel.getByRole('button', { name: 'Fermer le panneau', exact: true }).click()
      }
      // Cmd/Ctrl+K exposes the same toggle even without a search.
      await page.keyboard.press('Control+k')
      await page.getByRole('option', { name: /Activer le mode concentration/ }).click()
      await exit().waitFor()
      assert.equal(await composer.inputValue(), 'Brouillon conservé pendant la lecture')
      assert.deepEqual(errors, [])
      await context.close()
      console.log(`OK: ${profile}, ${size}, draft, panels, insertion, settings, tools, palette`)
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
