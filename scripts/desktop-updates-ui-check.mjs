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

// Exercise real Desktop/Server screens with deterministic update feeds. Native
// installation is checked separately by desktop-update-check.mjs.
const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'sillage-desktop-updates-ui-'))
const children = []
const shots = join(scratch, 'titlebar')
await mkdir(shots, { recursive: true })
let browser
async function start(profile) {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const config = join(scratch, `${profile}.toml`)
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok'].map((agent) => `[agents.${agent}]\nenabled = false`).join('\n'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(root, 'apps/server'),
    env: { ...process.env, SILLAGE_PROFILE: profile, SILLAGE_HANDSHAKE_FD: '3', SILLAGE_PORT: String(port),
      SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(scratch, profile),
      SILLAGE_WEB_ROOT: join(root, 'apps/web/dist') },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let diagnostics = ''
  let handshake = ''
  child.stdout.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
  child.stdio[3].on('data', (chunk) => { handshake += chunk })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(diagnostics)
    if ((profile !== 'desktop' || handshake.includes('\n')) && await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) {
      return { base, session: profile === 'desktop' ? JSON.parse(handshake).session : null }
    }
    await delay(100)
  }
  throw new Error(`Startup timed out: ${diagnostics}`)
}

try {
  const instances = { desktop: await start('desktop'), server: await start('server') }
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const profile of ['desktop', 'server']) {
    const { base, session } = instances[profile]
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 950 }, serviceWorkers: 'block', locale: 'fr-FR' })
      await context.addInitScript(({ desktop, width }) => {
        localStorage.setItem('sillage.locale', 'fr')
        if (!desktop) return
        let state = { status: 'idle', checkedAt: null }
        const listeners = new Set()
        window.updateProbe = {
          checks: 0, installs: 0,
          publish(next) { state = next; for (const listener of listeners) listener(next) },
        }
        window.chromeProbe = { menus: 0, colors: [] }
        window.sillageDesktop = { window: {
          platform: width === 1440 ? 'win32' : 'darwin',
          menu: async () => { window.chromeProbe.menus++ },
          colors: async (...colors) => { window.chromeProbe.colors.push(colors) },
        }, updates: {
          state: async () => state,
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
          check: async () => { window.updateProbe.checks++ },
          install: async () => { window.updateProbe.installs++ },
        } }
      }, { desktop: profile === 'desktop', width })
      if (session) await context.addCookies([{ name: 'sillage_session', value: session, url: base }])
      else {
        const response = width === 1440
          ? await context.request.post(`${base}/api/auth/setup`, { data: { username: 'tester', displayName: 'Tester', password: 'sillage-check-password' } })
          : await context.request.post(`${base}/api/auth/login`, { data: { username: 'tester', password: 'sillage-check-password' } })
        assert.ok(response.ok(), await response.text())
      }
      let info = { version: '0.24.2', channel: profile === 'desktop' ? 'desktop' : 'installer', latest: '0.25.0',
        updateAvailable: true, releases: [], checkedAt: null, checkError: null }
      await context.route('**/api/system/version*', (route) => route.fulfill({ json: info }))
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(base)
      if (width === 1440) {
        await page.waitForURL(/\/bienvenue$/)
        await page.getByRole('button', { name: 'Passer la visite' }).click()
        await page.getByRole('heading', { name: 'C’est prêt.' }).waitFor()
        await page.getByRole('button', { name: 'Créer mon premier projet' }).click()
      }
      await page.goto(`${base}/settings/a-propos`)
      await page.getByRole('heading', { name: 'À propos', exact: true }).waitFor()
      const bar = page.locator('.desktop-titlebar')
      assert.equal(await bar.count(), profile === 'desktop' ? 1 : 0)
      if (profile === 'desktop') {
        assert.equal((await bar.boundingBox()).height, 36)
        const layer = await page.locator('.app-layer').first().boundingBox()
        assert.equal(layer.y, 36)
        assert.equal(layer.y + layer.height, 950)
        assert.ok(await page.evaluate(() => window.chromeProbe.colors.length > 0))
        if (width === 1440) {
          await page.getByRole('button', { name: 'Menu de l’application' }).click()
          assert.equal(await page.evaluate(() => window.chromeProbe.menus), 1)
        } else assert.equal(await bar.getByRole('button').count(), 0)
        for (const theme of ['light', 'dark', 'dark-contrast']) {
          await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
          await page.screenshot({ path: join(shots, `${profile}-${width}-${theme}.png`) })
        }
        const colors = await page.evaluate(() => window.chromeProbe.colors)
        assert.ok(new Set(colors.map(([background]) => background)).size >= 3)
        assert.ok(colors.flat().every((color) => /^#[0-9a-f]{6}$/.test(color)))
      }
      const refresh = page.getByRole('button', { name: 'Vérifier maintenant' })
      const install = page.getByRole('button', { name: 'Redémarrer et mettre à jour', exact: true })
      if (profile === 'desktop') {
        assert.equal(await install.count(), 0)
        // The server lists 0.25.0 while the app is idle: About checks once by itself,
        // then admits the package was not found instead of promising a download.
        await page.waitForFunction(() => window.updateProbe.checks === 1)
        await page.getByText('Sillage télécharge cette version de lui-même', { exact: false }).waitFor()
        await page.evaluate(() => window.updateProbe.publish({ status: 'checking' }))
        await page.getByText('Recherche de la mise à jour…').waitFor()
        await page.evaluate(() => window.updateProbe.publish({ status: 'idle', checkedAt: new Date().toISOString() }))
        await page.getByText(/pas encore trouvé le paquet de la version 0\.25\.0/).waitFor()
        await page.screenshot({ path: join(scratch, `${profile}-${width}-not-found.png`), fullPage: true })
        await page.getByRole('button', { name: 'Réessayer', exact: true }).click()
        assert.equal(await page.evaluate(() => window.updateProbe.checks), 2)
        await refresh.click()
        assert.equal(await page.evaluate(() => window.updateProbe.checks), 3)
        await page.evaluate(() => window.updateProbe.publish({ status: 'downloading', version: '0.25.0', percent: 37 }))
        await page.getByText('37 %', { exact: true }).waitFor()
        await page.evaluate(() => window.updateProbe.publish({ status: 'ready', version: '0.25.0', installOnQuit: true }))
        await install.click()
        assert.equal(await page.evaluate(() => window.updateProbe.installs), 0)
        await page.getByRole('dialog').getByRole('button', { name: 'Redémarrer et mettre à jour', exact: true }).click()
        assert.equal(await page.evaluate(() => window.updateProbe.installs), 1)
        await page.screenshot({ path: join(scratch, `${profile}-${width}.png`), fullPage: true })
        // Windows announces the visible installer window; other platforms do not have one.
        await page.evaluate(() => window.updateProbe.publish({ status: 'installing', version: '0.25.0' }))
        await page.getByText(width === 1440 ? /fenêtre d'installation/ : /se rouvrir de lui-même/).waitFor()
        // An updater failure must remain visible when the separate GitHub query fails.
        info = { ...info, latest: null, updateAvailable: false, checkError: 'network' }
        await refresh.click()
        await page.getByText('0.25.0', { exact: true }).waitFor({ state: 'hidden' })
        await page.evaluate(() => window.updateProbe.publish({ status: 'error', message: 'Download failed for test', version: null, macPermission: false }))
        await page.getByText(/Download failed for test/).waitFor()
        await page.getByRole('button', { name: 'Réessayer', exact: true }).click()
        assert.equal(await page.evaluate(() => window.updateProbe.checks), 5)
        await page.evaluate(() => window.updateProbe.publish({ status: 'unsupported', reason: 'location' }))
        await page.getByText(/Applications/).waitFor()
      } else {
        assert.equal(await install.count(), 0)
        const serverInstall = page.getByRole('button', { name: /Mettre à jour vers/ })
        await serverInstall.click()
        await page.getByRole('dialog').waitFor()
        await page.keyboard.press('Escape')
        await page.screenshot({ path: join(scratch, `${profile}-${width}.png`), fullPage: true })
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${profile} overflows at ${width}px`)
      assert.deepEqual(errors, [])
      await context.close()
      console.log(`${profile} ${width}px: passed`)
    }
  }
  console.log(`Screenshots: ${scratch}`)
} finally {
  await browser?.close()
  for (const child of children) {
    if (child.exitCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  if (process.env.KEEP_DESKTOP_CHECK !== '1') await rm(scratch, { recursive: true, force: true })
}
