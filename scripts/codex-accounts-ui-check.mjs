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

// Comptes Codex supplémentaires : création, connexion par clé API et par code d'appareil,
// sélecteur de compte dans les défauts du CLI. Vrais composants, vraie API, base temporaire ;
// le vrai `codex app-server` est lancé pour les connexions, dans un home jetable.
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
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.opencode]\nenabled = false\n')
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // Créer un compte : il naît non connecté, avec les deux voies de connexion.
  await page.goto(`${base}/settings/comptes-codex`)
  await page.getByText('Aucun compte supplémentaire').waitFor()
  await page.getByRole('button', { name: 'Ajouter un compte' }).first().click()
  await page.getByLabel('Nom').fill('Boulot')
  await page.getByRole('button', { name: 'Créer le compte' }).click()
  await page.getByText('Non connecté').waitFor()
  const listed = await (await context.request.get(`${base}/api/codex-accounts`)).json()
  assert.equal(listed.accounts[0].status, 'pending')
  const id = listed.accounts[0].id

  // Clé API : Codex l'écrit dans le home du compte, sans joindre OpenAI.
  await page.getByRole('button', { name: 'Utiliser une clé API' }).click()
  await page.getByLabel('Clé API').fill('sk-test-bogus-key')
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
  await page.getByText('Connecté', { exact: true }).waitFor({ timeout: 30000 })
  await page.getByText('Clé API', { exact: true }).waitFor()
  assert.ok(!(await page.content()).includes('sk-test-bogus-key'), 'La clé ne revient jamais au navigateur')
  const authFile = join(data, 'data', 'codex-accounts', id, 'auth.json')
  assert.ok((await readFile(authFile, 'utf8')).includes('sk-test-bogus-key'), 'auth.json est dans le home du compte')
  assert.ok((await lstat(join(data, 'data', 'codex-accounts', id, 'config.toml')).catch(() => null))?.isSymbolicLink() ?? true, 'config.toml lié au home de l’utilisateur quand il existe')
  await page.screenshot({ path: '/tmp/sillage-codex-accounts-desktop.png' })

  // Le sélecteur de compte dans les défauts de Codex.
  await page.goto(`${base}/settings/cli`)
  await page.getByRole('radio', { name: /Codex/ }).click()
  const account = page.getByRole('combobox', { name: 'Compte' })
  await account.waitFor()
  await account.click()
  await page.getByRole('option', { name: 'Boulot' }).click()
  await delay(500)
  const settings = await (await context.request.get(`${base}/api/me/settings`)).json()
  assert.equal(settings.agentDefaults.codex.account, id)
  assert.equal(settings.agentDefaults.claude.account, null)

  // Déconnexion : le compte redevient en attente et disparaît du sélecteur.
  await page.goto(`${base}/settings/comptes-codex`)
  // Pas le bouton de la navigation, qui ferme la session Sillage : celui de la carte.
  await page.getByRole('button', { name: 'Déconnecter ce compte' }).click()
  await page.getByText('Non connecté').waitFor({ timeout: 30000 }).catch(async (err) => {
    await page.screenshot({ path: '/tmp/sillage-codex-accounts-failure.png' })
    console.log('état après déconnexion :', JSON.stringify(await (await context.request.get(`${base}/api/codex-accounts`)).json()))
    throw err
  })
  assert.equal((await (await context.request.get(`${base}/api/codex-accounts`)).json()).accounts[0].status, 'pending')
  assert.ok(!(await readFile(authFile, 'utf8').catch(() => '')).includes('sk-test'), 'auth.json retiré par Codex')

  // Code d'appareil : Codex rend une URL et un code, l'écran les montre, on annule.
  await page.getByRole('button', { name: "Se connecter par code d'appareil" }).click()
  await page.getByText('Ouvrir la page de connexion').waitFor({ timeout: 30000 })
  const code = await page.locator('code').first().textContent()
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{5}$/, code)
  const status = await (await context.request.get(`${base}/api/codex-accounts/${id}/login`)).json()
  assert.equal(status.state, 'pending')
  assert.ok(status.verificationUrl.startsWith('https://'))
  await page.screenshot({ path: '/tmp/sillage-codex-accounts-device.png' })
  await page.getByRole('button', { name: 'Annuler' }).click()
  await page.getByRole('button', { name: "Se connecter par code d'appareil" }).waitFor()
  assert.equal((await (await context.request.get(`${base}/api/codex-accounts/${id}/login`)).json()).state, 'idle')

  // Au téléphone : l'écran tient dans la largeur.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await mobile.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await mobile.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const phone = await mobile.newPage()
  await phone.goto(`${base}/settings/comptes-codex`)
  await phone.getByText('Boulot', { exact: true }).waitFor()
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.screenshot({ path: '/tmp/sillage-codex-accounts-mobile.png' })
  await mobile.close()

  assert.deepEqual(errors, [])
  console.log('OK : création, clé API dans le home du compte, sélecteur Codex, déconnexion, code d’appareil, mobile.')
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
