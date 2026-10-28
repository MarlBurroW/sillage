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

// Exercise both profiles with isolated databases and deterministic CLI installation states.
// Queue safety and access control are covered by cli-updates.test.ts; no host CLI is installed here.
const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'sillage-cli-updates-ui-'))
const children = []
const shots = join(scratch, 'screenshots')
await mkdir(shots, { recursive: true })
let browser
async function start(profile) {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const config = join(scratch, `${profile}.toml`)
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok', 'antigravity'].map((agent) => `[agents.${agent}]\nenabled = false`).join('\n'))
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

async function settingsLink(page, label) {
  let link = page.getByRole('link', { name: label, exact: false })
  if (!await link.first().isVisible()) {
    await page.getByRole('link', { name: 'Réglages', exact: true }).click()
    const agents = page.getByRole('button', { name: /^Agents/ })
    if (await agents.getAttribute('aria-expanded') !== 'true') await agents.click()
    link = page.getByRole('link', { name: label, exact: false })
  }
  await link.first().click()
}

try {
  const instances = { desktop: await start('desktop'), server: await start('server') }
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const profile of ['desktop', 'server']) {
    const { base, session } = instances[profile]
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390,
        serviceWorkers: 'block', locale: 'fr-FR' })
      await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
      if (session) await context.addCookies([{ name: 'sillage_session', value: session, url: base }])
      else {
        const auth = await context.request.post(`${base}/api/auth/${width === 1440 ? 'setup' : 'login'}`, {
          data: { username: 'tester', displayName: 'Tester', password: 'sillage-check-password' },
        })
        assert.ok(auth.ok(), await auth.text())
      }
      const settings = await context.request.patch(`${base}/api/me/settings`, { data: { onboarding: { pending: false } } })
      assert.ok(settings.ok(), await settings.text())
      const entries = ['claude', 'codex', 'opencode', 'grok', 'antigravity'].map((agent, i) => ({
        agent, binary: agent, enabled: i !== 4, installed: i < 3, installable: i !== 4, managed: i === 0,
        path: i < 3 ? `C:\\Users\\Tester\\AppData\\Roaming\\npm\\${agent}.cmd` : null,
        version: ['2.1.312', '0.146.0', '1.99.0', null, null][i],
        preferredVersion: ['2.1.312', '0.163.0', '1.19.3', '1.0.62', '1.4.3'][i],
        reason: i === 4 ? 'disabled' : i === 3 ? 'not_on_path' : null, install: { status: 'idle' },
      }))
      const codex = entries[1]
      let installs = 0, refreshes = 0, catalogs = 0
      let rejectInstall = true
      await context.route('**/api/system/version*', (route) => route.fulfill({ json: { version: '0.27.0', channel: profile, latest: '0.27.0', updateAvailable: false, releases: [], checkedAt: 1, checkError: null } }))
      await context.route('**/api/agents**', async (route) => {
        const url = new URL(route.request().url())
        if (url.pathname === '/api/agents') {
          if (url.searchParams.has('refresh')) refreshes++
          return route.fulfill({ json: { agents: entries } })
        }
        if (url.pathname.endsWith('/install')) {
          assert.equal(url.pathname, '/api/agents/codex/install')
          if (route.request().method() === 'DELETE') {
            codex.install = { status: 'idle' }
            return route.fulfill({ status: 204 })
          }
          if (rejectInstall) {
            rejectInstall = false
            return route.fulfill({ status: 503, json: { error: { code: 'test_offline', message: 'Test network unavailable' } } })
          }
          installs++
          codex.install = { status: 'queued', version: codex.preferredVersion, reason: 'sessions' }
          return route.fulfill({ status: 202, json: codex.install })
        }
        if (url.pathname.endsWith('/models')) {
          if (url.pathname.includes('/codex/')) catalogs++
          return route.fulfill({ json: { models: [{ value: 'model', displayName: codex.version === '0.146.0' ? 'Ancien modèle' : 'Nouveau modèle',
            description: '', hint: null, isDefault: true, efforts: [], defaultEffort: null, supportsFastMode: false }],
            modes: [], account: null, outputStyles: [], fastMode: null, agents: [], fetchedAt: Date.now() } })
        }
        if (url.pathname.endsWith('/usage')) return route.fulfill({ json: { plan: null, limitsAvailable: false, windows: [], credits: null, fetchedAt: Date.now() } })
        return route.continue()
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${base}/settings/cli`)
      await page.getByRole('radio', { name: /Codex/ }).click()
      await page.getByRole('combobox', { name: 'Modèle', exact: true }).click()
      await page.getByRole('option', { name: /Ancien modèle/ }).click()
      const before = catalogs
      assert.ok(before > 0)
      await settingsLink(page, 'Versions des CLI')
      await page.getByRole('heading', { name: 'Versions des CLI', exact: true }).waitFor()
      assert.equal(await page.locator('a[href="/settings/cli-versions"]').getAttribute('aria-current'), 'page')
      const row = page.getByRole('listitem', { name: 'Codex', exact: true })
      await row.getByText('0.146.0', { exact: true }).waitFor()
      assert.equal(await page.getByRole('listitem', { name: 'OpenCode', exact: true }).getByRole('button').count(), 0, 'Never downgrade a newer version')
      await page.getByRole('listitem', { name: 'Claude Code', exact: true }).getByText('À jour', { exact: true }).waitFor()
      await page.screenshot({ path: join(shots, `${profile}-${width}.png`), fullPage: true })
      const update = row.getByRole('button', { name: 'Mettre à jour vers 0.163.0' })
      await update.click()
      await row.getByText('Test network unavailable').waitFor()
      await row.getByRole('button', { name: 'Réessayer', exact: true }).click()
      await row.getByText(/En attente de la fin des sessions/).waitFor()
      await row.getByRole('button', { name: 'Annuler l’attente' }).click()
      await update.waitFor()
      await update.click()
      await row.getByText(/En attente de la fin des sessions/).waitFor()
      codex.install = { status: 'running', version: '0.163.0', startedAt: Date.now() - 10_000, fetched: 7, current: 'codex-0.163.0.tgz' }
      await row.getByRole('progressbar').waitFor()
      codex.install = { status: 'failed', version: '0.163.0', error: 'Installation interrupted for test' }
      await row.getByText('Installation interrupted for test').waitFor()
      await row.getByRole('button', { name: 'Réessayer', exact: true }).click()
      await row.getByText(/En attente de la fin des sessions/).waitFor()
      codex.version = '0.163.0'
      codex.managed = true
      codex.install = { status: 'idle' }
      await row.getByText('À jour', { exact: true }).waitFor()
      assert.equal(installs, 3)
      await page.getByRole('button', { name: 'Vérifier les versions' }).click()
      await page.getByRole('button', { name: 'Vérifier les versions' }).waitFor()
      assert.equal(refreshes, 1)
      await settingsLink(page, 'Défauts des CLI')
      await page.getByRole('radio', { name: /Codex/ }).click()
      await page.getByRole('combobox', { name: 'Modèle', exact: true }).filter({ hasText: 'Nouveau modèle' }).waitFor()
      assert.ok(catalogs > before, 'Update invalidates the cached models without reloading the app')
      await settingsLink(page, 'Versions des CLI')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${profile} overflows at ${width}px`)
      if (profile === 'server') {
        await context.route('**/api/auth/me', async (route) => {
          const response = await route.fetch()
          return route.fulfill({ response, json: { ...await response.json(), isAdmin: false } })
        })
        codex.version = '0.146.0'
        await page.reload()
        await page.getByText('Seul un administrateur peut installer ou mettre à jour les CLI du serveur.').waitFor()
        assert.equal(await row.getByRole('button').count(), 0, 'Regular users can only read versions')
      }
      assert.deepEqual(errors, [])
      await context.close()
      console.log(`${profile} ${width}px: passed`)
    }
  }
  console.log(`Screenshots: ${shots}`)
} finally {
  await browser?.close()
  for (const child of children) {
    if (child.exitCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  if (process.env.KEEP_CLI_CHECK !== '1') await rm(scratch, { recursive: true, force: true })
}
