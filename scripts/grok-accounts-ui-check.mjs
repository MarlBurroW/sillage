import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Extra Grok accounts: creation, API-key/device-code sign-in, CLI-default account
// selector. Real components/API, temporary database; CLI is test fake Grok
// (`apps/server/test/fixtures/grok-agent.mjs`), speaking like Grok Build 1.0.62
// without contacting xAI.
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
  const grok = join(data, 'grok.mjs')
  await copyFile(join(serverDir, 'test/fixtures/grok-agent.mjs'), grok)
  await chmod(grok, 0o700)
  await writeFile(config, `[agents.claude]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nbinary = "${grok}"\n`)
  const userGrokHome = join(data, 'user-grok')
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
    // “User” Grok home linked by accounts, and device-code confirmation slow enough
    // for the screen to show waiting.
    GROK_HOME: userGrokHome,
    FIXTURE_LOGIN_DELAY: '60000',
  }
  await mkdir(join(userGrokHome, 'sessions'), { recursive: true })
  await writeFile(join(userGrokHome, 'config.toml'), '[cli]\n')
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // Settings menu entry leads to page.
  await page.goto(`${base}/settings`)
  await page.getByRole('link', { name: /Comptes Grok/ }).first().click()
  await page.waitForURL(/\/settings\/comptes-grok$/)

  // Create account: initially signed out with both sign-in methods.
  await page.getByText('Aucun compte supplémentaire').waitFor()
  await page.getByRole('button', { name: 'Ajouter un compte' }).first().click()
  await page.getByLabel('Nom').fill('Perso')
  await page.getByRole('button', { name: 'Créer le compte' }).click()
  await page.getByText('Non connecté').waitFor()
  const listed = await (await context.request.get(`${base}/api/grok-accounts`)).json()
  assert.equal(listed.accounts[0].status, 'pending')
  const id = listed.accounts[0].id
  const accountHome = join(data, 'data', 'grok-accounts', id)

  // API key: Grok writes it in account home; never returned to browser.
  await page.getByRole('button', { name: 'Utiliser une clé API' }).click()
  await page.getByLabel('Clé API xAI').fill('xai-test-bogus-key')
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  await page.getByText('Connecté', { exact: true }).waitFor({ timeout: 30000 })
  await page.getByText('Clé API xAI', { exact: true }).waitFor()
  assert.ok(!(await page.content()).includes('xai-test-bogus-key'), 'La clé ne revient jamais au navigateur')
  assert.ok((await readFile(join(accountHome, 'auth.json'), 'utf8')).length > 0, 'auth.json est dans le home du compte')
  assert.ok((await lstat(join(accountHome, 'sessions'))).isSymbolicLink(), 'les sessions sont celles du home de l’utilisateur')
  await page.screenshot({ path: '/var/tmp/sillage-grok-accounts-desktop.png' })

  // Account selector in Grok defaults.
  await page.goto(`${base}/settings/cli`)
  await page.getByRole('radio', { name: /Grok Build/ }).click()
  const account = page.getByRole('combobox', { name: 'Compte' })
  await account.waitFor()
  await account.click()
  await page.getByRole('option', { name: 'Perso' }).click()
  await delay(500)
  const settings = await (await context.request.get(`${base}/api/me/settings`)).json()
  assert.equal(settings.agentDefaults.grok.account, id)

  // Account gauge read through `_x.ai/billing` in its home.
  const usage = await (await context.request.get(`${base}/api/agents/grok/usage?account=${id}`)).json()
  assert.equal(usage.plan, 'X Premium')
  assert.equal(usage.windows[0]?.id, 'credits')

  // Sign-out returns account to pending and removes its sign-in.
  await page.goto(`${base}/settings/comptes-grok`)
  await page.getByRole('button', { name: 'Déconnecter ce compte' }).click()
  await page.getByText('Non connecté').waitFor({ timeout: 30000 })
  assert.equal((await (await context.request.get(`${base}/api/grok-accounts`)).json()).accounts[0].status, 'pending')
  assert.equal(await readFile(join(accountHome, 'auth.json'), 'utf8').catch(() => null), null, 'auth.json retiré')

  // Device code: screen shows URL/code printed by `grok login`, then cancel.
  await page.getByRole('button', { name: "Se connecter par code d'appareil" }).click()
  await page.getByText('Ouvrir la page de connexion').waitFor({ timeout: 30000 })
  assert.equal(await page.locator('code').first().textContent(), 'W68V-VRXD')
  const status = await (await context.request.get(`${base}/api/grok-accounts/${id}/login`)).json()
  assert.equal(status.state, 'pending')
  assert.equal(status.verificationUrl, 'https://accounts.x.ai/oauth2/device?user_code=W68V-VRXD')
  await page.screenshot({ path: '/var/tmp/sillage-grok-accounts-device.png' })
  await page.getByRole('button', { name: 'Annuler' }).click()
  await page.getByRole('button', { name: "Se connecter par code d'appareil" }).waitFor()
  assert.equal((await (await context.request.get(`${base}/api/grok-accounts/${id}/login`)).json()).state, 'idle')

  // Phone: screen fits width.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await mobile.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await mobile.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const phone = await mobile.newPage()
  await phone.goto(`${base}/settings/comptes-grok`)
  await phone.getByText('Perso', { exact: true }).waitFor()
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.screenshot({ path: '/var/tmp/sillage-grok-accounts-mobile.png' })
  await mobile.close()

  assert.deepEqual(errors, [])
  console.log('OK : menu, création, clé API dans le home du compte, sélecteur Grok, jauge, déconnexion, code d’appareil, mobile.')
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
