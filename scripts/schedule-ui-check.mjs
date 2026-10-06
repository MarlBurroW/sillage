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

// Vrais composants, vraie API et vrai CLI Claude, dans une base temporaire : la tâche
// créée ici tire pour de bon, à la minute. Compter deux tours très courts de quota.
// Les captures vont dans SCHEDULE_SHOTS, ou dans un dossier temporaire annoncé à la fin.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-schedule-check-'))
const shots = process.env.SCHEDULE_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-schedule-shots-')))
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
  await writeFile(config, '[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n')
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
  await context.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const api = async (path) => (await context.request.get(`${base}${path}`)).json()
  const project = (await api('/api/projects')).find((entry) => entry.name === 'Nimbus')
  const schedules = async () => (await api('/api/schedules')).filter((task) => task.projectId === project.id)
  /** Attend qu'un état de la tâche soit vrai, le temps d'un tir réel. */
  const until = async (label, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const [task] = await schedules()
      if (task && predicate(task)) return task
      await delay(1000)
    }
    throw new Error(`Timeout: ${label}\n${server.diagnostics}`)
  }

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mkdir(shots, { recursive: true })

  // --- Création par le formulaire ------------------------------------------------
  await page.goto(`${base}/p/${project.id}/schedules`)
  await page.getByText('Aucune tâche planifiée dans ce projet').waitFor()
  await page.getByRole('button', { name: 'Nouvelle tâche', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche planifiée', exact: true })
  await dialog.getByRole('textbox', { name: 'Nom', exact: true }).fill('Veille de test')
  await dialog.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Réponds seulement « OK », sans utiliser aucun outil.')
  // Sans cadence valide, rien ne part : le bouton doit le dire.
  await dialog.getByRole('spinbutton', { name: 'Tous les', exact: true }).fill('0')
  assert.equal(await dialog.getByRole('button', { name: 'Créer la tâche', exact: true }).isDisabled(), true)
  await dialog.getByRole('radio', { name: 'Cron', exact: true }).click()
  await dialog.getByText(/À 09:00, uniquement le lundi/).waitFor()
  await dialog.getByRole('radio', { name: 'Intervalle', exact: true }).click()
  await dialog.getByRole('spinbutton', { name: 'Tous les', exact: true }).fill('1')
  await dialog.getByRole('combobox', { name: 'Unité', exact: true }).click()
  await page.getByRole('option', { name: 'minutes', exact: true }).click()
  await dialog.getByRole('spinbutton', { name: 'Durée maximale (min)', exact: true }).fill('3')
  await dialog.getByText(/Prochain tir :/).waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'form-desktop.png') })
  await dialog.getByRole('button', { name: 'Créer la tâche', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  const card = page.locator('[data-schedule="Veille de test"]')
  await card.getByText('Active', { exact: true }).waitFor()
  await card.getByText('Toutes les 1 min').waitFor()
  const [created] = await schedules()
  assert.deepEqual(created.cadence, { kind: 'interval', minutes: 1 })
  assert.equal(created.maxDurationMinutes, 3)

  // --- Le tir part tout seul, à l'heure ------------------------------------------
  const fired = await until('le tir planifié part', (task) => task.runs.some((entry) => entry.conversationId), 100_000)
  const run1 = fired.runs.find((entry) => entry.conversationId)
  assert.equal(run1.trigger, 'schedule')
  const thread = (await api('/api/conversations')).find((entry) => entry.id === run1.conversationId)
  assert.equal(thread.scheduleId, created.id)
  assert.match(thread.title, /^Veille de test · /)

  // En pause tout de suite : un seul tir automatique suffit à la preuve.
  await card.getByRole('button', { name: 'Mettre en pause', exact: true }).click()
  await until('la tâche est en pause', (task) => !task.enabled && task.nextRunAt === null, 10_000)

  // La sidebar : le fil n'est pas dans la liste du projet, il est sous sa tâche.
  const nav = page.locator('aside nav')
  const threadLink = nav.locator(`a[href$="/c/${thread.id}"]`)
  const section = nav.locator('[data-sidebar-schedules]')
  await section.getByText('Planifiées', { exact: true }).waitFor()
  assert.equal(await threadLink.count(), 0, 'Un tir ne doit pas apparaître dans la liste principale')
  await section.getByRole('button', { name: /Veille de test/ }).click()
  await threadLink.waitFor()
  assert.equal(await threadLink.count(), 1)
  assert.equal(await section.locator(`a[href$="/c/${thread.id}"]`).count(), 1, 'Le tir est rangé sous sa tâche')

  const done = await until('le tir se termine', (task) => task.runs.every((entry) => entry.status !== 'running'), 150_000)
  assert.equal(done.runs.find((entry) => entry.id === run1.id).status, 'succeeded', JSON.stringify(done.runs))
  await card.getByRole('button', { name: /Historique des tirs/ }).click()
  await card.getByText('terminé', { exact: true }).first().waitFor({ timeout: 30_000 })
  await page.screenshot({ animations: 'disabled', path: join(shots, 'schedule-desktop.png') })

  // Le fil s'ouvre comme une conversation ordinaire, et l'agent a su qu'il tournait seul.
  await threadLink.click()
  await page.getByText(/personne n'est au clavier/).first().waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'run-desktop.png') })

  // --- Lancer maintenant, depuis le téléphone ------------------------------------
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}/p/${project.id}/schedules`)
  await card.getByText('En pause', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ animations: 'disabled', path: join(shots, 'schedule-mobile.png') })
  await card.getByRole('button', { name: 'Lancer maintenant', exact: true }).click()
  const manual = await until('le tir manuel part', (task) => task.runs.some((entry) => entry.trigger === 'manual'), 60_000)
  assert.equal(manual.enabled, false, 'Lancer maintenant ne sort pas la tâche de sa pause')
  await card.getByText('En cours', { exact: true }).waitFor({ timeout: 30_000 })

  await page.getByRole('button', { name: /^Ouvrir la navigation/ }).click()
  const drawer = page.locator('aside nav')
  await drawer.locator('[data-sidebar-schedules]').getByRole('button', { name: /Veille de test/ }).click()
  await drawer.locator('[data-sidebar-schedules] a[href*="/c/"]').nth(1).waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'sidebar-mobile.png') })
  await page.getByRole('button', { name: 'Fermer la navigation', exact: true }).click()

  await page.getByRole('button', { name: 'Modifier', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Modifier la tâche', exact: true })
  assert.equal(await editor.getByRole('textbox', { name: 'Nom', exact: true }).inputValue(), 'Veille de test')
  const saveBox = await editor.getByRole('button', { name: 'Enregistrer', exact: true }).boundingBox()
  assert.ok(saveBox.y + saveBox.height <= 844, 'The mobile save action remains visible')
  assert.equal(await editor.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
  await page.screenshot({ animations: 'disabled', path: join(shots, 'form-mobile.png') })
  await editor.getByRole('button', { name: 'Annuler', exact: true }).click()

  await until('le tir manuel se termine', (task) => task.runs.every((entry) => entry.status !== 'running'), 150_000)

  // --- Suppression : les fils redeviennent des conversations ordinaires, rangées --
  await page.setViewportSize({ width: 1440, height: 900 })
  await card.getByRole('button', { name: 'Supprimer', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer', exact: true }).click()
  await page.getByText('Aucune tâche planifiée dans ce projet').waitFor()
  const after = (await api('/api/conversations')).filter((entry) => entry.title.startsWith('Veille de test · '))
  assert.equal(after.length, 2)
  assert.ok(after.every((entry) => entry.scheduleId === null && entry.archivedAt !== null))
  assert.equal(await nav.locator('[data-sidebar-schedules]').count(), 0)

  assert.deepEqual(errors, [])
  console.log(`schedule-ui-check: ok (captures dans ${shots})`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
