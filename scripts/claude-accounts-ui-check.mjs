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

// Extra Claude accounts: settings screen, then account selector in CLI defaults.
// Real components and API, temporary database, no CLI launched.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-ui-check-'))
const processes = []
let browser

const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(48)

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
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
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

  // Screen: empty, then an added account, never a token displayed.
  await page.goto(`${base}/settings/comptes-claude`)
  await page.getByText('Aucun compte supplémentaire').waitFor()
  await page.getByRole('button', { name: 'Ajouter un compte' }).first().click()
  await page.getByLabel('Nom').fill('Boulot')
  // Guided sign-in is offered first; pasting a secret is the alternative.
  await page.getByRole('radio', { name: /Coller un jeton/ }).click()
  await page.getByLabel('Jeton ou clé API').fill('sk-ant-api03-pas-le-bon')
  await page.getByRole('button', { name: 'Enregistrer le compte' }).click()
  await page.getByText(/sk-ant-oat01/).first().waitFor()
  assert.equal(await page.getByText('Comptes enregistrés').count(), 1)
  await page.getByLabel('Jeton ou clé API').fill(TOKEN)
  await page.getByRole('button', { name: 'Enregistrer le compte' }).click()
  await page.getByText('Secret mis à jour le').waitFor()
  await page.getByText('Abonnement', { exact: true }).waitFor()
  // A subscription reads its gauge with its own token: no second sign-in to offer.
  await page.getByText(/Lecture de l’usage…|Usage illisible pour l’instant|5 heures/).first().waitFor({ timeout: 60000 })
  assert.equal(await page.getByRole('button', { name: /jauge/i }).count(), 0)
  assert.ok(!(await page.content()).includes(TOKEN), 'Le jeton ne revient jamais au navigateur')
  // A Console API key is recognized by prefix and displayed accordingly.
  await page.getByRole('button', { name: 'Ajouter un compte' }).first().click()
  await page.getByLabel('Nom').fill('Boîte')
  await page.getByRole('radio', { name: /Coller un jeton/ }).click()
  await page.getByLabel('Jeton ou clé API').fill('sk-ant-api03-' + 'k'.repeat(40))
  await page.getByRole('button', { name: 'Enregistrer le compte' }).click()
  await page.getByText('Clé API', { exact: true }).waitFor()
  const listed = await (await context.request.get(`${base}/api/claude-accounts`)).json()
  assert.deepEqual(listed.accounts.map((entry) => [entry.label, entry.kind]), [['Boulot', 'oauth'], ['Boîte', 'apiKey']])
  assert.ok(listed.accounts.every((entry) => !('token' in entry)))
  await page.screenshot({ path: '/tmp/sillage-claude-accounts-desktop.png' })
  const keyed = listed.accounts[1].id
  await context.request.delete(`${base}/api/claude-accounts/${keyed}`)
  // Deleted through the API outside the page: only rereading reveals it.
  await page.reload()
  await page.getByText('Boulot', { exact: true }).waitFor()

  // Guided sign-in without a CLI: screen says the CLI printed nothing, then cancel.
  await page.getByRole('button', { name: 'Ajouter un compte' }).first().click()
  await page.getByLabel('Nom').fill('Guidé')
  await page.getByRole('button', { name: 'Lancer la connexion' }).click()
  await page.getByText("Ouvrir la page d'autorisation").or(page.getByRole('alert')).first().waitFor({ timeout: 40000 })
  await page.getByRole('button', { name: 'Annuler' }).click()
  await page.getByRole('button', { name: 'Ajouter un compte' }).first().waitFor()

  // Rename without touching the token.
  await page.getByRole('button', { name: 'Modifier' }).click()
  await page.getByLabel('Nom').fill('Travail')
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await page.getByText('Travail', { exact: true }).waitFor()

  // CLI-default account selector and its persistence.
  await page.goto(`${base}/settings/cli`)
  const account = page.getByRole('combobox', { name: 'Compte' })
  await account.waitFor()
  await account.click()
  const option = page.getByRole('option', { name: 'Travail' })
  await option.waitFor()
  assert.equal(await page.getByRole('option', { name: /Connexion du CLI/ }).count(), 1)
  await option.click()
  await delay(500)
  const settings = await (await context.request.get(`${base}/api/me/settings`)).json()
  assert.equal(settings.agentDefaults.claude.account, listed.accounts[0].id)
  await page.reload()
  await page.getByRole('combobox', { name: 'Compte' }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Compte' }).textContent(), 'Travail')

  // A deleted account remains selected: the selector says so rather than going blank.
  const removed = await context.request.delete(`${base}/api/claude-accounts/${listed.accounts[0].id}`)
  assert.equal(removed.status(), 204)
  await page.reload()
  await page.getByRole('combobox', { name: 'Compte' }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Compte' }).textContent(), 'Compte supprimé')
  await page.getByRole('combobox', { name: 'Compte' }).click()
  await page.getByRole('option', { name: /Connexion du CLI/ }).click()
  await delay(500)
  assert.equal((await (await context.request.get(`${base}/api/me/settings`)).json()).agentDefaults.claude.account, null)
  await page.reload()
  await page.getByRole('combobox', { name: 'Modèle' }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Compte' }).count(), 0, 'Sans compte, pas de sélecteur')

  // Phone: screen fits the width.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await mobile.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await mobile.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  await mobile.request.post(`${base}/api/claude-accounts`, { data: { label: 'Perso', token: TOKEN } })
  const phone = await mobile.newPage()
  await phone.goto(`${base}/settings/comptes-claude`)
  await phone.getByText('Perso', { exact: true }).waitFor()
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.screenshot({ path: '/tmp/sillage-claude-accounts-mobile.png' })
  await mobile.close()

  assert.deepEqual(errors, [])
  console.log('OK : ajout, renommage, jeton jamais rendu, sélecteur de compte persistant, compte supprimé signalé, mobile.')
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
