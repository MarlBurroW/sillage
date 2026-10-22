import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Autonomous-session decisions end to end: a scheduled-task session requests a
// decision (through the same queue as MCP), toast and “Decisions” section appear,
// answer through the dialog, history retains it. Then notifications screen: devices,
// test, preferences. No CLI runs: session uses disabled Codex, and answer delivery
// fails harmlessly. Screenshots go to DECISIONS_SHOTS or a temporary directory.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
const data = await mkdtemp(join(tmpdir(), 'sillage-decisions-check-'))
const shots = process.env.DECISIONS_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-decisions-shots-')))
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

  // A scheduled task allowing decisions and one of its sessions.
  const db = new Database(join(data, 'data', 'sillage.db'))
  const project = db.prepare("SELECT id, owner_id AS ownerId FROM projects WHERE name = 'Nimbus'").get()
  const now = Date.now()
  db.prepare(
    `INSERT INTO scheduled_tasks (id, project_id, user_id, name, agent, config, prompt, cadence, execution_mode, overlap_policy,
       max_duration_minutes, enabled, decisions_enabled, decision_max_hours, created_at, updated_at)
     VALUES ('task', ?, ?, 'Veille des dépendances', 'codex', '{}', 'p', '{"kind":"interval","minutes":1440}', 'fresh', 'skip', 30, 0, 1, 24, ?, ?)`,
  ).run(project.id, project.ownerId, now, now)
  const session = randomUUID()
  db.prepare(
    `INSERT INTO conversations (id, project_id, user_id, title, agent, config, status, schedule_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Veille des dépendances · 12/10 09:00', 'codex', '{}', 'idle', 'task', ?, ?)`,
  ).run(session, project.id, project.ownerId, now, now)
  const ask = (payload) =>
    db.prepare("INSERT INTO agent_requests (id, project_id, conversation_id, kind, payload, created_at) VALUES (?, ?, ?, 'request_decision', ?, ?)")
      .run(randomUUID(), project.id, session, JSON.stringify(payload), Date.now())

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/p/${project.id}/board`)
  await page.getByRole('heading', { name: 'Board' }).waitFor()
  assert.equal(await page.getByRole('region', { name: 'À décider' }).count(), 0, 'No section without pending decisions')

  // Session asks: toast and section appear without reload.
  ask({
    question: 'Monter vite en 7.0 maintenant ?',
    context: '**Vite 7.0** est sorti hier. Les tests passent sur la branche `chore/vite-7`, mais deux plugins affichent des avertissements de dépréciation.\n\n- [Notes de version](https://vite.dev/blog)\n- Diff : 4 fichiers',
    options: ['Oui, fusionner', 'Attendre la 7.0.1', 'Non'],
    default: 'Attendre la 7.0.1',
  })
  const toast = page.getByRole('region', { name: 'Notifications' })
  await toast.getByText('Monter vite en 7.0 maintenant ?').waitFor({ timeout: 15000 })
  const section = page.getByRole('region', { name: 'À décider' })
  await section.getByText('Monter vite en 7.0 maintenant ?').waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'decisions-toast.png') })

  // Dialog: context, choices, detail, submit.
  await toast.getByRole('button', { name: 'Répondre' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('Vite 7.0', { exact: false }).first().waitFor()
  await dialog.getByRole('radio', { name: /Attendre la 7\.0\.1/ }).waitFor()
  await dialog.getByRole('radio', { name: /Oui, fusionner/ }).click()
  await dialog.getByLabel(/Précision pour l'agent/).fill('Vérifie d’abord les avertissements des deux plugins.')
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(shots, 'decisions-dialog.png') })
  await dialog.getByRole('button', { name: 'Envoyer' }).click()
  await dialog.getByText('Répondu par', { exact: false }).waitFor()
  await page.screenshot({ path: join(shots, 'decisions-answered.png') })
  await page.keyboard.press('Escape')
  await section.waitFor({ state: 'detached' })
  assert.equal(await toast.count(), 0, 'The toast leaves once answered')
  const stored = db.prepare('SELECT status, answer_option AS option, answer_text AS text FROM decisions').get()
  assert.deepEqual(stored, { status: 'answered', option: 'Oui, fusionner', text: 'Vérifie d’abord les avertissements des deux plugins.' })

  // History, and a second request opened from the sidebar.
  ask({ question: 'Fermer l’issue #18 comme doublon de #12 ?', options: ['Oui', 'Non'] })
  await section.getByText('Fermer l’issue #18', { exact: false }).waitFor({ timeout: 15000 })
  await page.goto(`${base}/decisions`)
  await page.getByRole('tab', { name: 'Toutes' }).click()
  await page.getByRole('main').getByText('Monter vite en 7.0 maintenant ?').waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'decisions-history.png') })

  // Notifications: devices, test without devices, preferences.
  await page.goto(`${base}/settings/notifications`)
  await page.getByRole('heading', { name: 'Appareils abonnés' }).waitFor()
  await page.getByText('Aucun appareil n’est encore abonné', { exact: false }).or(page.getByText("Aucun appareil n'est encore abonné", { exact: false })).waitFor()
  await page.getByRole('switch', { name: 'Demandes des agents' }).click()
  await page.getByRole('button', { name: 'Envoyer une notification de test' }).click()
  await page.getByText('Aucun appareil à qui l’envoyer', { exact: false }).or(page.getByText("Aucun appareil à qui l'envoyer", { exact: false })).waitFor({ timeout: 20000 })
  const settings = await (await context.request.get(`${base}/api/me/settings`)).json()
  assert.equal(settings.notifications.cliRequest, false)
  await page.screenshot({ path: join(shots, 'decisions-notifications.png'), fullPage: true })

  // Phone: section in navigation drawer, decision in a sheet.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block', storageState: await context.storageState() })
  await phone.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const mobile = await phone.newPage()
  mobile.on('pageerror', (error) => errors.push(error.message))
  await mobile.goto(`${base}/decisions`)
  await mobile.getByRole('main').getByText('Fermer l’issue #18', { exact: false }).click()
  await mobile.getByRole('dialog').getByRole('radio', { name: 'Oui' }).waitFor()
  await mobile.waitForTimeout(300)
  await mobile.screenshot({ path: join(shots, 'decisions-phone-dialog.png') })
  await phone.close()

  assert.deepEqual(errors, [])
  console.log(`Décisions : parcours complet vérifié. Captures dans ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
