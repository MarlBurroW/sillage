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

// First-run tour end to end: empty database, first account created in browser, every
// step through “Ready”, then an invited member. Real components and API; installed
// CLIs are probed as they are.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-onboarding-check-'))
const processes = []
let browser

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env, stdio = 'pipe') {
  const child = spawn(process.execPath, args, { cwd, env, stdio })
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
  await writeFile(config, '[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n')
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

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const heading = () => page.getByRole('heading', { level: 1 })
  const next = (name) => page.getByRole('button', { name }).click()

  // Empty database: any address opens first-account creation.
  await page.goto(`${base}/p/quelque-chose`)
  await heading().filter({ hasText: 'Créer ton compte' }).waitFor()
  // Language can change on the first screen, even before account creation.
  await page.getByRole('button', { name: 'English' }).click()
  await heading().filter({ hasText: 'Create your account' }).waitFor()
  await page.getByRole('button', { name: 'Français' }).click()
  await heading().filter({ hasText: 'Créer ton compte' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Passer la visite' }).count(), 0, 'Le compte ne se passe pas')
  await page.getByLabel('Nom affiché').fill('Nicolas Dupont')
  assert.equal(await page.getByLabel('Identifiant').inputValue(), 'nicolas-dupont')
  await page.getByLabel('Identifiant').fill('nicolas')
  await page.getByLabel('Mot de passe', { exact: true }).fill('correct horse battery')
  await page.getByLabel('Confirmer').fill('correct horse')
  await page.getByText('Les deux mots de passe diffèrent.').waitFor()
  // An effect updates button state from the form: wait for it instead of reading it.
  await page.locator('button:disabled', { hasText: 'Créer le compte' }).waitFor()
  await page.getByLabel('Confirmer').fill('correct horse battery')
  await page.screenshot({ path: '/tmp/sillage-onboarding-account.png' })
  // Enter in a field activates the step's button.
  await page.getByLabel('Confirmer').press('Enter')

  // Welcome: account created, session open, first name reused.
  await heading().filter({ hasText: 'Bienvenue dans Sillage, Nicolas Dupont.' }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/bienvenue')
  // Detected CLIs (Claude Code and Codex here) start selected; keep only Claude.
  // Checked state follows the probe, then the account.
  await page.getByRole('checkbox', { name: /Claude Code.*installé ici/, checked: true }).waitFor({ timeout: 30000 })
  const codex = page.getByRole('checkbox', { name: /^Codex/ })
  if ((await codex.getAttribute('aria-checked')) === 'true') await codex.click()
  await page.getByRole('checkbox', { name: /^Codex/, checked: false }).waitFor()
  await page.getByRole('checkbox', { name: /Claude Code/, checked: true }).waitFor()
  await page.getByRole('radio', { name: /Aussi depuis le téléphone/ }).click()
  await page.getByRole('radio', { name: /Aussi depuis le téléphone/, checked: true }).waitFor()
  await page.screenshot({ path: '/tmp/sillage-onboarding-welcome.png' })
  await next('Commencer')

  // Appearance: theme updates live on <html>.
  await heading().filter({ hasText: 'Apparence' }).waitFor()
  await page.getByRole('button', { name: 'Clair' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  await page.getByRole('button', { name: 'Sombre', exact: true }).click()
  await next('Continuer')

  // Agents: one row for Claude Code, probed on the machine.
  await heading().filter({ hasText: 'Tes agents' }).waitFor()
  await page.getByText('Claude Code', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.screenshot({ path: '/tmp/sillage-onboarding-agents.png' })

  // Reload resumes the same step: state belongs to the account.
  await page.reload()
  await heading().filter({ hasText: 'Tes agents' }).waitFor()
  // The list goes backward, then forward up to the furthest reached step, not beyond.
  await page.locator('aside ol li button', { hasText: 'Apparence' }).click()
  await heading().filter({ hasText: 'Apparence' }).waitFor()
  assert.equal(await page.locator('aside ol li button:disabled', { hasText: 'Comment l’agent travaille' }).count(), 1, 'une étape jamais atteinte ne se clique pas')
  await page.locator('aside ol li button', { hasText: 'Tes agents' }).click()
  await heading().filter({ hasText: 'Tes agents' }).waitFor()
  await next('Continuer')

  // Permissions: “Accept edits” goes into selected CLI defaults. Checkpoints are
  // explained without configuration: they are per project, and the tour creates none.
  await heading().filter({ hasText: 'Comment l’agent travaille' }).waitFor()
  await page.getByText('Points de reprise par tour').waitFor()
  await page.getByRole('radio', { name: /Éditions acceptées/ }).click()
  await page.getByRole('radio', { name: /Éditions acceptées/, checked: true }).waitFor()
  // Detailed panel: composer groups per CLI, including Claude budget.
  await page.getByRole('button', { name: 'Régler chaque CLI en détail' }).click()
  await page.getByText('Budget par conversation').waitFor()
  await page.getByText(/Modèle/).first().waitFor({ timeout: 60000 })
  await page.screenshot({ path: '/tmp/sillage-onboarding-work-detail.png', fullPage: true })
  await next('Continuer')

  // Instructions and memory: two account defaults. Select native memory so the trial
  // project below can inherit it.
  await heading().filter({ hasText: 'Consignes et mémoire' }).waitFor()
  await page.getByRole('radio', { name: /Celle de chaque CLI/ }).click()
  await page.getByRole('radio', { name: /Celle de chaque CLI/, checked: true }).waitFor()
  await page.screenshot({ path: '/tmp/sillage-onboarding-memory.png' })
  await next('Continuer')

  // Instructions: a chip writes one line, saved on “Continue”.
  await heading().filter({ hasText: 'Tes consignes' }).waitFor()
  await page.getByRole('button', { name: 'Vérifie avant d’annoncer' }).click()
  await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('Lance les tests et le typecheck'))
  await next('Continuer')

  // Address: this browser's address is local; replace with an HTTPS address.
  await heading().filter({ hasText: 'Adresse et téléphone' }).waitFor()
  await page.getByText('Réseau local, sans HTTPS').waitFor()
  await page.getByText('Joignable seulement sur ton réseau.').waitFor()
  await page.getByLabel('Adresse publique').fill('https://sillage.example.com/')
  await page.getByText('HTTPS, joignable de partout').waitFor()
  await page.getByAltText('Code QR de l’adresse de l’instance').waitFor()
  await page.screenshot({ path: '/tmp/sillage-onboarding-address.png' })
  await page.getByLabel('Adresse publique').press('Enter')

  // Ready: summary, then the project-creation screen because no project exists yet.
  await heading().filter({ hasText: 'C’est prêt.' }).waitFor()
  await page.getByText('Éditions acceptées').waitFor()
  assert.equal(await page.getByText('Projet', { exact: true }).count(), 0, 'la visite ne parle plus de projet')
  await page.screenshot({ path: '/tmp/sillage-onboarding-ready.png' })
  await next('Créer mon premier projet')
  await page.waitForURL(/\/projects\/new$/)

  // The trial project is now the fourth New Project source: Sillage writes it into
  // a nonexistent directory and opens its first conversation.
  await page.getByRole('radio', { name: /Projet d’essai/ }).click()
  await page.getByLabel('Dossier des projets').fill(join(data, 'projects'))
  await page.getByRole('button', { name: 'Créer le projet d’essai' }).click()
  await page.waitForURL(/\/p\/[^/]+\/c\/new$/)
  await page.screenshot({ path: '/tmp/sillage-onboarding-project.png' })

  // Read what the tour left behind through the API.
  const settings = await (await context.request.get(`${base}/api/me/settings`)).json()
  assert.equal(settings.onboarding.pending, false)
  assert.equal(settings.agentDefaults.claude.permissionMode, 'acceptEdits')
  assert.equal(settings.agentDefaults.claude.maxBudgetUsd, null)
  assert.deepEqual(settings.onboarding.answers.agents, ['claude'])
  const instructions = await (await context.request.get(`${base}/api/instructions`)).json()
  assert.match(instructions.content, /Lance les tests et le typecheck/)
  const appSettings = await (await context.request.get(`${base}/api/settings`)).json()
  assert.equal(appSettings.publicUrl, 'https://sillage.example.com')
  const projects = await (await context.request.get(`${base}/api/projects`)).json()
  assert.equal(projects.length, 1)
  assert.equal(projects[0].name, 'Sillage sample')
  assert.equal(projects[0].workspacePath, join(data, 'projects', 'sillage-sample'))
  // Trial project inherits account default: native memory, nothing to list; owner can
  // switch back to Sillage and the card regains its directory.
  assert.equal(settings.projectDefaults.memoryMode, 'native')
  assert.equal(projects[0].memoryMode, 'native')
  const nativeMemory = await (await context.request.get(`${base}/api/projects/${projects[0].id}/memory`)).json()
  assert.equal(nativeMemory.mode, 'native')
  assert.deepEqual(nativeMemory.files, [])
  assert.ok((await context.request.patch(`${base}/api/projects/${projects[0].id}`, { data: { memoryMode: 'sillage' } })).ok())
  const sillageMemory = await (await context.request.get(`${base}/api/projects/${projects[0].id}/memory`)).json()
  assert.equal(sillageMemory.mode, 'sillage')
  assert.ok(sillageMemory.dir.length > 0)

  // Returning to /bienvenue after the tour redirects to the application.
  await page.goto(`${base}/bienvenue`)
  await page.waitForURL((url) => !url.pathname.startsWith('/bienvenue'))

  // Invited member: tour begins with their account, and “Skip” leads to summary.
  const created = await context.request.post(`${base}/api/users`, { data: { username: 'bob', displayName: 'Bob', password: 'provisoire-123', isAdmin: false } })
  assert.ok(created.ok(), await created.text())
  const member = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await member.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await member.request.post(`${base}/api/auth/login`, { data: { username: 'bob', password: 'provisoire-123' } })
  const phone = await member.newPage()
  phone.on('pageerror', (error) => errors.push(error.message))
  await phone.goto(`${base}/`)
  await phone.waitForURL(/\/bienvenue$/)
  await phone.getByRole('heading', { level: 1 }).filter({ hasText: 'Ton compte' }).waitFor()
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Pas de débordement au téléphone')
  await phone.screenshot({ path: '/tmp/sillage-onboarding-member-mobile.png', fullPage: true })
  await phone.getByLabel('Nom affiché').fill('Bob Martin')
  await phone.getByRole('button', { name: 'Enregistrer' }).click()
  await phone.getByRole('heading', { level: 1 }).filter({ hasText: 'Bienvenue dans Sillage, Bob Martin.' }).waitFor()
  // No team question for members, nor global instructions.
  assert.equal(await phone.getByText('Sur cette instance').count(), 0)
  await phone.getByRole('button', { name: 'Passer' }).click()
  await phone.getByRole('heading', { level: 1 }).filter({ hasText: 'C’est prêt.' }).waitFor()
  assert.equal(await phone.getByText('Consignes', { exact: true }).count(), 0)
  await phone.screenshot({ path: '/tmp/sillage-onboarding-member-ready.png', fullPage: true })
  // The only project belongs to the administrator and is private: member sees none,
  // and their tour also ends at project creation.
  await phone.getByRole('button', { name: 'Créer mon premier projet' }).click()
  await phone.waitForURL(/\/projects\/new$/)
  const bobSettings = await (await member.request.get(`${base}/api/me/settings`)).json()
  assert.equal(bobSettings.onboarding.pending, false)
  const me = await (await member.request.get(`${base}/api/auth/me`)).json()
  assert.equal(me.displayName, 'Bob Martin')
  await member.close()

  // “Replay tour” from About reopens the first step.
  await page.goto(`${base}/settings/a-propos`)
  await page.getByRole('button', { name: 'Revoir la visite' }).click()
  await page.waitForURL(/\/bienvenue$/)
  await heading().filter({ hasText: 'Ton compte' }).waitFor()
  await page.getByText('Compte prêt : Nicolas Dupont (nicolas), administrateur.').waitFor()

  // Sillage Desktop: launcher creates account and opens session; tour starts at
  // Welcome without account, team, phone, or address questions. Simulate without
  // Electron: SILLAGE_PROFILE=desktop and handshake on descriptor 3, exactly as
  // apps/desktop/src/server.ts does. Web comes from a build: desktop serves its
  // interface through the server, not Vite.
  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...env, NODE_ENV: 'production' })
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)
  const desktopPort = await freePort()
  const desktop = run(['--import', 'tsx', 'src/main.ts'], serverDir, {
    ...env,
    SILLAGE_PROFILE: 'desktop',
    SILLAGE_HANDSHAKE_FD: '3',
    SILLAGE_PORT: String(desktopPort),
    SILLAGE_DATA_DIR: join(data, 'desktop-data'),
    SILLAGE_WEB_ROOT: webDist,
  }, ['pipe', 'pipe', 'pipe', 'pipe'])
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    desktop.stdio[3].setEncoding('utf8')
    desktop.stdio[3].on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end !== -1) resolve(JSON.parse(buffer.slice(0, end)))
    })
    desktop.once('exit', () => reject(new Error(`serveur bureau arrêté : ${desktop.diagnostics}`)))
  })
  const desktopOrigin = `http://127.0.0.1:${handshake.port}`
  const window = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await window.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await window.addCookies([{ name: 'sillage_session', value: handshake.session, url: desktopOrigin }])
  const desk = await window.newPage()
  desk.on('pageerror', (error) => errors.push(error.message))
  await desk.goto(`${desktopOrigin}/`)
  await desk.waitForURL(/\/bienvenue$/)
  await desk.getByRole('heading', { level: 1 }).filter({ hasText: /^Bienvenue dans Sillage/ }).waitFor()
  const instance = await desk.evaluate(() => fetch('/api/system/instance').then((response) => response.json()))
  assert.equal(instance.profile, 'desktop')
  assert.equal(instance.needsSetup, false)
  // First-account route does not exist in Desktop: launcher already created its account.
  const setup = await desk.evaluate(() => fetch('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'x', displayName: 'X', password: 'correct horse battery' }) }).then((response) => response.status))
  assert.equal(setup, 404)
  const titles = await desk.locator('aside ol li').allTextContents()
  assert.equal(titles.length, 7, `sept étapes en bureau, pas ${titles.length}`)
  assert.ok(!titles.some((title) => /Adresse|compte/.test(title)), titles.join(' | '))
  await desk.getByText('installés sur cet ordinateur').waitFor()
  assert.equal(await desk.getByText('Sur cette instance').count(), 0, 'pas de question d’équipe en bureau')
  assert.equal(await desk.getByText('Tu t’en serviras').count(), 0, 'pas de question de téléphone en bureau')
  await desk.screenshot({ path: '/tmp/sillage-onboarding-desktop-welcome.png' })
  await desk.getByRole('button', { name: 'Passer la visite' }).click()
  await desk.getByRole('heading', { level: 1 }).filter({ hasText: 'C’est prêt.' }).waitFor()
  for (const absent of ['Compte', 'Adresse publique', 'Téléphone']) {
    assert.equal(await desk.getByText(absent, { exact: true }).count(), 0, `${absent} n’a rien à faire en bureau`)
  }
  await desk.screenshot({ path: '/tmp/sillage-onboarding-desktop-ready.png' })
  // New database, no project: tour ends at first-project creation.
  await desk.getByRole('button', { name: 'Créer mon premier projet' }).click()
  await desk.waitForURL(/\/projects\/new$/)
  await window.close()

  assert.deepEqual(errors, [])
  console.log('OK : premier compte, visite complète, membre invité au téléphone, visite rejouée, profil bureau.')
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
