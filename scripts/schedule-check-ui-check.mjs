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

// Vérification avant le tour, de bout en bout : essai du script dans le formulaire,
// tir écarté par le script, tir lancé avec sa sortie (vrai CLI Claude, un tour court),
// validation d'un script proposé par un agent, et rendu au téléphone.
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
  const seeded = await api('/api/schedules')
  const project = (await api('/api/projects')).find((entry) => !entry.archivedAt && !seeded.some((task) => task.projectId === entry.id))
  const mine = async () => (await api('/api/schedules')).find((task) => task.projectId === project.id)
  const until = async (label, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const task = await mine()
      if (task && predicate(task)) return task
      await delay(500)
    }
    throw new Error(`Timeout: ${label}\n${server.diagnostics}`)
  }
  /** Remplace le contenu d'un éditeur CodeMirror. */
  const typeScript = async (scope, text) => {
    const editor = scope.locator('[data-check-section] .cm-content')
    await editor.click()
    await editor.press('Control+a')
    await editor.press('Delete')
    await editor.pressSequentially(text)
  }

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mkdir(shots, { recursive: true })

  // --- Création, avec un script qui ne trouve rien ---------------------------------
  await page.goto(`${base}/p/${project.id}/schedules`)
  await page.getByRole('button', { name: 'Nouvelle automatisation', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Nouvelle automatisation', exact: true })
  await dialog.getByRole('textbox', { name: 'Nom', exact: true }).fill('Veille avec vérification')
  await dialog.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Réponds seulement « OK », sans utiliser aucun outil.')
  await dialog.getByRole('button', { name: 'Ajouter une vérification', exact: true }).click()
  // Le modèle de départ est un vrai script, qui parle du dossier d'état.
  await dialog.locator('[data-check-section] .cm-content').getByText('SILLAGE_STATE_DIR').first().waitFor()
  await typeScript(dialog, 'echo "Rien de neuf"; exit 10')
  await dialog.getByRole('button', { name: 'Tester', exact: true }).click()
  await dialog.locator('[data-check-result="skip"]').waitFor({ timeout: 30_000 })
  await dialog.locator('[data-check-result]').getByText('Rien de neuf').waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'check-form-desktop.png') })
  await dialog.getByRole('button', { name: 'Créer la tâche', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  const card = page.locator('[data-schedule="Veille avec vérification"]')
  await card.getByText('script avant chaque tour, 120 s au plus').waitFor()
  let task = await mine()
  assert.equal(task.check.approved, true)

  // --- « Lancer maintenant » : le script écarte le tir, sans session ----------------
  await card.getByRole('button', { name: 'Lancer maintenant', exact: true }).click()
  task = await until('tir écarté', (entry) => entry.runs[0]?.status === 'skipped', 30_000)
  assert.equal(task.runs[0].error, 'Rien de neuf')
  assert.equal(task.runs[0].conversationId, null)
  assert.equal(task.runs[0].check.exitCode, 10)
  await card.getByRole('button', { name: /Historique des tirs/ }).click()
  await card.getByText('· rien à faire').waitFor()

  // --- Le script trouve quelque chose : le tour part avec sa sortie -----------------
  await card.getByRole('button', { name: 'Modifier', exact: true }).click()
  const editor = page.getByRole('dialog')
  await typeScript(editor, 'echo "Version 9.9 publiée"')
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  await card.getByRole('button', { name: 'Lancer maintenant', exact: true }).click()
  task = await until('tour lancé', (entry) => entry.runs[0]?.conversationId, 90_000)
  const conversationId = task.runs[0].conversationId
  const events = await api(`/api/conversations/${conversationId}/events?after=0`)
  const first = events.entries.map((entry) => entry.event).find((event) => event.type === 'message.completed' && event.role === 'user')
  const text = first.blocks.map((block) => block.text ?? '').join('')
  assert.match(text, /Version 9\.9 publiée/)
  await until('tour terminé', (entry) => entry.runs[0]?.status === 'succeeded', 150_000)

  // --- Un script proposé par un agent : validation depuis la conversation ---------
  // Le formulaire valide d'office ; l'agent passe par `schedule_task`. On simule sa
  // proposition en base, sur ce serveur jetable, avec l'appel d'outil qui l'a faite.
  const { default: Database } = await import(join(serverDir, 'node_modules/better-sqlite3/lib/index.js'))
  const db = new Database(join(data, 'data', 'sillage.db'))
  const script = 'echo "proposé par un agent"; exit 10'
  db.prepare("UPDATE scheduled_tasks SET check_script = ?, check_approved_at = NULL, check_proposed_by = 'agent' WHERE id = ?").run(script, task.id)
  const owner = db.prepare('SELECT owner_id AS id FROM projects WHERE id = ?').get(project.id).id
  const now = Date.now()
  const threadEvents = [
    { type: 'message.completed', messageId: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Vérifie chaque jour la version de Codex.' }], parentToolCallId: null },
    { type: 'tool.started', toolCallId: 'call-1', name: 'mcp__sillage__schedule_task', input: { name: task.name, prompt: 'Analyse', cron: '0 9 * * *', check_script: script }, parentToolCallId: null },
    { type: 'tool.completed', toolCallId: 'call-1', output: [{ type: 'text', text: `Tâche planifiée « ${task.name} » créée, id ${task.id}.` }], isError: false, durationMs: 800 },
    { type: 'message.completed', messageId: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'C’est planifié. Le script attend ta validation.' }], parentToolCallId: null },
  ]
  db.prepare(`INSERT INTO conversations (id, project_id, user_id, title, agent, config, status, last_seq, last_notable_seq, position, created_at, updated_at)
              VALUES ('agent-thread', ?, ?, 'Planifier la veille Codex', 'claude', ?, 'idle', ?, ?, -100, ?, ?)`)
    .run(project.id, owner, JSON.stringify({ agent: 'claude', model: 'default', effort: 'medium', permissionMode: 'bypassPermissions' }), threadEvents.length, threadEvents.length, now, now)
  const insertEvent = db.prepare('INSERT INTO events (conversation_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
  threadEvents.forEach((event, index) => insertEvent.run('agent-thread', index + 1, now + index, event.type, JSON.stringify(event)))
  db.close()

  // La tâche se signale « À valider » sur sa carte, avant même qu'on l'ouvre.
  await page.reload()
  await card.getByText('À valider', { exact: true }).waitFor()
  await card.getByText('Script de vérification à valider').waitFor()
  await card.getByRole('button', { name: 'Lancer maintenant', exact: true }).click()
  task = await until('tir bloqué', (entry) => /en attente de validation/.test(entry.runs[0]?.error ?? ''), 15_000)
  assert.equal(task.runs[0].check, null, 'Un script non validé ne tourne pas')

  // Le raccourci : sous l'appel de l'agent, dans la conversation.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}/p/${project.id}/c/agent-thread`)
  const strip = page.locator('[data-check-approval]')
  await strip.waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, 'check-inline-mobile.png') })
  await strip.getByRole('button', { name: 'Relire et valider', exact: true }).click()
  const review = page.getByRole('dialog')
  await review.getByText('proposé par un agent').first().waitFor()
  await review.getByRole('button', { name: 'Tester', exact: true }).click()
  await review.locator('[data-check-result="skip"]').waitFor({ timeout: 30_000 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ animations: 'disabled', path: join(shots, 'check-review-mobile.png') })
  await review.getByRole('button', { name: 'Valider', exact: true }).click()
  await review.waitFor({ state: 'hidden' })
  await until('script validé', (entry) => entry.check?.approved === true, 10_000)
  await page.getByText(`Script de vérification de « ${task.name} » validé.`).waitFor()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ animations: 'disabled', path: join(shots, 'check-inline-approved-desktop.png') })

  await page.goto(`${base}/p/${project.id}/schedules`)
  await card.getByText('Script de vérification à valider').waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 390, height: 844 })

  // --- Le formulaire au téléphone -------------------------------------------------
  await card.getByRole('button', { name: 'Modifier', exact: true }).click()
  const mobileForm = page.getByRole('dialog')
  await mobileForm.locator('[data-check-section]').scrollIntoViewIfNeeded()
  assert.equal(await mobileForm.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true)
  await page.screenshot({ animations: 'disabled', path: join(shots, 'check-form-mobile.png') })
  const save = await mobileForm.getByRole('button', { name: 'Enregistrer', exact: true }).boundingBox()
  assert.ok(save.y + save.height <= 844, 'The save action stays visible on a phone')
  await mobileForm.getByRole('button', { name: 'Annuler', exact: true }).click()

  assert.deepEqual(errors, [])
  console.log(`schedule-check-ui-check: ok (captures dans ${shots})`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
