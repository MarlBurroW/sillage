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

// Retours d'un utilisateur Windows (20 oct. 2026) : avancement de l'installation d'un
// CLI, CLI manquants masquables, sélection de texte dans les cellules d'un tableau,
// clic droit dans la sidebar. Vrais composants, vraie API, base temporaire. Les CLI
// Codex et Grok sont déclarés sur des binaires introuvables pour forcer leur absence.
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
  await writeFile(config, '[agents.opencode]\nenabled = false\n[agents.codex]\nbinary = "/nonexistent/codex"\n[agents.grok]\nbinary = "/nonexistent/grok"\n')
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

  // 1. Deux CLI manquants, deux rangs « Installer », chacun masquable.
  await page.goto(`${base}/p/${project.id}/c/new?agent=claude`)
  await page.getByText(/Codex n'est pas installé/).waitFor()
  await page.getByText(/Grok Build n'est pas installé/).waitFor()
  assert.equal(await page.locator('input[name="draft-agent"]').count(), 4, 'claude, codex, opencode (coupé), grok proposés')
  await page.screenshot({ path: '/tmp/sillage-wf-install-rows.png', fullPage: true })
  await page.getByRole('button', { name: 'Ne plus proposer' }).first().click()
  await page.getByText(/Codex n'est pas installé/).waitFor({ state: 'detached' })
  await page.getByText(/Masqués tant qu’ils ne sont pas installés : Codex\./).waitFor()
  assert.equal(await page.locator('input[name="draft-agent"]').count(), 3, 'codex retiré du choix')
  await page.getByRole('button', { name: 'Ne plus proposer' }).first().click()
  await page.getByText(/Masqués tant qu’ils ne sont pas installés : Codex, Grok Build\./).waitFor()
  assert.equal(await page.locator('input[name="draft-agent"]').count(), 2, 'claude et opencode coupé')
  // Le masque est au compte : il survit au rechargement.
  await page.reload()
  await page.getByText(/Masqués tant qu’ils ne sont pas installés : Codex, Grok Build\./).waitFor()
  const settings = await (await context.request.get(`${base}/api/me/settings`)).json()
  assert.deepEqual(settings.hiddenAgents, ['codex', 'grok'])
  await page.screenshot({ path: '/tmp/sillage-wf-install-hidden.png', fullPage: true })
  await page.getByRole('button', { name: 'Afficher', exact: true }).click()
  await page.getByText(/Codex n'est pas installé/).waitFor()
  assert.equal(await page.locator('input[name="draft-agent"]').count(), 4)

  // 2. L'avancement d'une installation : l'état « running » est injecté dans la
  //    réponse de la sonde, l'installation réelle durant plusieurs minutes.
  await page.route('**/api/agents', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    for (const entry of body.agents) {
      if (entry.agent === 'codex') {
        entry.install = { status: 'running', version: entry.preferredVersion, startedAt: Date.now() - 83_000, fetched: 14, current: 'codex-0.163.0.tgz' }
      }
    }
    await route.fulfill({ response, json: body })
  })
  await page.reload()
  const progress = page.getByRole('progressbar', { name: /Installation de Codex/ })
  await progress.waitFor()
  await page.getByText(/Téléchargement de codex-0\.163\.0\.tgz · 14 fichiers reçus/).waitFor()
  await page.getByText(/^1 min 2[3-6] s$/).waitFor()
  assert.equal(await page.getByRole('button', { name: /Installer 0\.163/ }).count(), 0, 'le bouton laisse la place à l’avancement')
  await page.screenshot({ path: '/tmp/sillage-wf-install-progress.png', fullPage: true })
  await page.unroute('**/api/agents')

  // 3. Clic droit sur une session de la sidebar, puis sur l'en-tête d'un projet.
  const row = page.getByRole('link', { name: /Radar tile prefetch|prefetch/i }).first()
  await row.waitFor()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Renommer' }).waitFor()
  await page.getByRole('menuitem', { name: 'Supprimer' }).waitFor()
  await page.screenshot({ path: '/tmp/sillage-wf-context-conversation.png' })
  await page.keyboard.press('Escape')
  await page.getByRole('menuitem', { name: 'Renommer' }).waitFor({ state: 'detached' })
  // `force` : vu seul, le projet n'est pas déplaçable et dnd-kit pose aria-disabled sur
  // son en-tête, que Playwright lit comme un élément inactif.
  await page.getByRole('link', { name: 'Nimbus', exact: true }).first().click({ button: 'right', force: true })
  await page.getByRole('menuitem', { name: 'Board' }).waitFor()
  await page.getByRole('menuitem', { name: 'Renommer' }).waitFor()
  await page.screenshot({ path: '/tmp/sillage-wf-context-project.png' })
  await page.keyboard.press('Escape')

  // 4. Une sélection commencée dans une cellule n'en sort pas.
  await row.click()
  const cell = page.locator('.sg-table-scroll td', { hasText: 'Tablet' }).first()
  await cell.waitFor()
  const from = await cell.boundingBox()
  const target = await page.locator('.sg-table-scroll td', { hasText: '420 ms' }).first().boundingBox()
  await page.mouse.move(from.x + 4, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 4 })
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  const selected = await page.evaluate(() => document.getSelection()?.toString() ?? '')
  await page.mouse.up()
  assert.equal(selected, 'Tablet (1024×768)', `sélection confinée à la cellule, obtenu « ${selected} »`)
  await page.screenshot({ path: '/tmp/sillage-wf-table-selection.png' })

  // Au téléphone : pas de clic droit, le bouton « … » reste la voie ; la page de
  // brouillon reste dans la largeur avec ses rangs d'installation.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await mobile.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await mobile.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const phone = await mobile.newPage()
  await phone.goto(`${base}/p/${project.id}/c/new?agent=claude`)
  await phone.getByText(/Codex n'est pas installé/).waitFor()
  await delay(800)
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.screenshot({ path: '/tmp/sillage-wf-mobile.png', fullPage: true })
  await mobile.close()

  // 5. Sillage Desktop : un seul compte, donc ni choix privé/partagé à la création d'un
  //    projet ni badge dans ses réglages. Profil simulé sans Electron, comme dans
  //    onboarding-ui-check : SILLAGE_PROFILE=desktop et la poignée de main sur le
  //    descripteur 3 ; le web vient d'un build, la fenêtre de bureau ne passe pas par Vite.
  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...env, NODE_ENV: 'production' })
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)
  const desktop = run(['--import', 'tsx', 'src/main.ts'], serverDir, {
    ...env,
    SILLAGE_PROFILE: 'desktop',
    SILLAGE_HANDSHAKE_FD: '3',
    SILLAGE_PORT: String(await freePort()),
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
  await desk.getByRole('button', { name: 'Passer la visite' }).click()
  await desk.getByRole('heading', { level: 1 }).filter({ hasText: 'C’est prêt.' }).waitFor()
  // Le bouton de fin de visite mène à la création de projet, et c'est lui qui clôt la
  // visite : y aller par l'URL avant ramènerait à la visite.
  await desk.getByRole('button', { name: 'Créer mon premier projet' }).click()
  await desk.waitForURL(/\/projects\/new$/)
  await desk.getByLabel('Nom', { exact: true }).first().waitFor()
  assert.equal(await desk.getByText(/^Visibilité$/).count(), 0, 'pas de choix privé/partagé en bureau')
  await desk.screenshot({ path: '/tmp/sillage-wf-desktop-new-project.png', fullPage: true })
  const workspace = join(data, 'desktop-workspace')
  await mkdir(workspace)
  const created = await (await window.request.post(`${desktopOrigin}/api/projects`, { data: { name: 'Essai', workspacePath: workspace } })).json()
  assert.ok(created.id, JSON.stringify(created))
  await desk.goto(`${desktopOrigin}/p/${created.id}`)
  await desk.getByRole('heading', { level: 1, name: 'Essai' }).waitFor()
  await desk.getByLabel('Nom', { exact: true }).first().waitFor()
  assert.equal(await desk.getByText(/^(Visibilité|Privé)$/).count(), 0, 'ni badge ni réglage de visibilité en bureau')
  await desk.screenshot({ path: '/tmp/sillage-wf-desktop-project.png', fullPage: true })
  await window.close()

  assert.deepEqual(errors, [])
  console.log('OK : rangs masquables, avancement d’installation, clic droit, sélection en cellule, mobile, bureau sans visibilité.')
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
