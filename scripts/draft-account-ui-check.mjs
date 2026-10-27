import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// New-session account choice, with usage below each account name. Real components/API,
// temporary database; real CLIs are probed for usage.
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
  await writeFile(config, '[agents.opencode]\nenabled = false\n')
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  delete env.NODE_ENV
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const projects = await (await context.request.get(`${base}/api/projects`)).json()
  const project = projects.find((entry) => entry.name === 'Nimbus')
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // Without extra accounts, nothing is added to the screen.
  await page.goto(`${base}/p/${project.id}/c/new?agent=claude`)
  await page.getByRole('radiogroup', { name: 'Agent' }).or(page.locator('input[name="draft-agent"]').first()).first().waitFor()
  await delay(1500)
  assert.equal(await page.getByRole('radiogroup', { name: 'Compte' }).count(), 0, 'Pas de choix sans compte')

  // One token-based Claude account and one key-signed-in Codex account.
  await context.request.post(`${base}/api/claude-accounts`, { data: { label: 'Boulot', token: 'sk-ant-oat01-' + 'x'.repeat(60) } })
  const codex = await (await context.request.post(`${base}/api/codex-accounts`, { data: { label: 'Codex Boîte' } })).json()
  const login = await context.request.post(`${base}/api/codex-accounts/${codex.id}/login`, { data: { type: 'apiKey', apiKey: 'sk-test-bogus' } })
  assert.ok(login.ok(), await login.text())

  await page.goto(`${base}/p/${project.id}/c/new?agent=claude`)
  const group = page.getByRole('radiogroup', { name: 'Compte' })
  await group.waitFor()
  // Subscription tokens read their own usage; this fake one cannot, and says so.
  await page.getByRole('radio', { name: /Boulot/ }).getByText(/pas pu être lu/).waitFor({ timeout: 60000 })
  assert.equal(await page.getByRole('radio', { name: /Connexion du CLI/ }).getAttribute('aria-checked'), 'true')
  // Usage for the CLI's sign-in appears below its option, read from the real CLI.
  await page.getByRole('radio', { name: /Connexion du CLI/ }).getByText(/%|Pas de limite|pas pu être lu/).waitFor({ timeout: 40000 })
  console.log('claude CLI hint:', await page.getByRole('radio', { name: /Connexion du CLI/ }).textContent())
  await page.getByRole('radio', { name: /Boulot/ }).click()
  assert.equal(await page.getByRole('radio', { name: /Boulot/ }).getAttribute('aria-checked'), 'true')
  await page.mouse.move(10, 990)
  await delay(400)
  await page.screenshot({ path: '/tmp/sillage-draft-account-claude.png', fullPage: true })

  // Selection matches the composer: its “Account” setting reflects it.
  // Codex: signed-in account and CLI sign-in are offered with their usage.
  await page.locator('input[name="draft-agent"][value="codex"]').check()
  await page.getByRole('radio', { name: /Codex Boîte/ }).waitFor()
  await page.getByRole('radio', { name: /Codex Boîte/ }).getByText(/Clé API · facturée/).waitFor()
  await page.getByRole('radio', { name: /Connexion du CLI/ }).getByText(/%|Pas de limite|pas pu être lu/).waitFor({ timeout: 40000 })
  console.log('codex account hint:', await page.getByRole('radio', { name: /Codex Boîte/ }).textContent())
  console.log('codex CLI hint:', await page.getByRole('radio', { name: /Connexion du CLI/ }).textContent())
  await page.getByRole('radio', { name: /Codex Boîte/ }).click()
  await page.mouse.move(10, 990)
  await delay(400)
  await page.screenshot({ path: '/tmp/sillage-draft-account-codex.png', fullPage: true })

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await mobile.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await mobile.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const phone = await mobile.newPage()
  await phone.goto(`${base}/p/${project.id}/c/new?agent=claude`)
  await phone.getByRole('radiogroup', { name: 'Compte' }).waitFor()
  await delay(1500)
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.screenshot({ path: '/tmp/sillage-draft-account-mobile.png', fullPage: true })
  await mobile.close()

  assert.deepEqual(errors, [])
  console.log('OK : choix du compte au brouillon, usage par option, Claude et Codex, mobile.')
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}
