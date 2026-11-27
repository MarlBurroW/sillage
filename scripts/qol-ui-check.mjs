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

// Small comforts, end to end on a disposable demo instance with every CLI disabled:
// ↑/↓ recall in the composer, a long paste turned into a text attachment and put back,
// the tab title and icon counting what waits, and a sound played for a decision away
// from the viewed conversation. Screenshots go to QOL_SHOTS or a temporary directory.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
const data = await mkdtemp(join(tmpdir(), 'sillage-qol-check-'))
const shots = process.env.QOL_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-qol-shots-')))
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

/** Count synthesized notes: headless Chromium has no speakers, the oscillators prove the sound. */
function countNotes() {
  window.__notes = 0
  const original = AudioContext.prototype.createOscillator
  AudioContext.prototype.createOscillator = function (...args) {
    window.__notes += 1
    return original.apply(this, args)
  }
}

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n')
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

  const db = new Database(join(data, 'data', 'sillage.db'))
  const hero = db.prepare("SELECT c.id, c.project_id AS projectId, c.title FROM events e JOIN conversations c ON c.id = e.conversation_id WHERE e.payload LIKE '%msg_user_1%' LIMIT 1").get()
  assert.ok(hero, 'The demo seeds a conversation with user messages')
  const lastUser = db.prepare("SELECT payload FROM events WHERE conversation_id = ? AND type = 'message.completed' AND payload LIKE '%\"role\":\"user\"%' ORDER BY seq DESC LIMIT 1").get(hero.id)
  const lastText = JSON.parse(lastUser.payload).blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await context.addInitScript(countNotes)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // --- Composer: ↑ recalls, ↓ gives the empty field back --------------------------------------
  await page.goto(`${base}/p/${hero.projectId}/c/${hero.id}`)
  const field = page.locator('form textarea').first()
  await field.waitFor()
  await page.waitForFunction((title) => document.title.endsWith(`${title} · Sillage`), hero.title, { timeout: 15000 }).catch(async (error) => { throw new Error(`Title: ${await page.title()} / expected ${hero.title}: ${error.message}`) })
  await field.click()
  await page.keyboard.press('ArrowUp')
  assert.equal(await field.inputValue(), lastText, '↑ in an empty field recalls the last message')
  await page.keyboard.press('ArrowDown')
  assert.equal(await field.inputValue(), '', '↓ past the newest gives the empty field back')
  await field.fill('brouillon')
  await page.keyboard.press('ArrowUp')
  assert.equal(await field.inputValue(), 'brouillon', '↑ never replaces writing')
  await field.fill('')

  // --- Long paste becomes a text file, and can be put back -------------------------------------
  const long = Array.from({ length: 60 }, (_, index) => `ligne ${index + 1} : TypeError at render (main.tsx:${index})`).join('\n')
  await field.evaluate((node, text) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', text)
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, long)
  const chip = page.getByRole('link', { name: /texte-colle-60-lignes\.txt/ })
  await chip.waitFor({ timeout: 10000 })
  assert.equal(await field.inputValue(), '', 'The paste did not land in the field')
  await field.fill('Regarde ces logs :')
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'qol-paste-chip.png') })
  await page.getByRole('button', { name: 'Remettre ce collage dans le message, en texte' }).click()
  await chip.waitFor({ state: 'detached' })
  assert.ok((await field.inputValue()).includes('ligne 60 : TypeError'), 'Put back as text')
  await field.fill('')

  // --- Settings: sounds on for this device ------------------------------------------------------
  await page.goto(`${base}/settings/sons`)
  await page.getByRole('heading', { name: 'Sons', exact: true }).waitFor()
  await page.getByRole('switch', { name: 'Sons sur cet appareil' }).click()
  const before = await page.evaluate(() => window.__notes)
  await page.getByRole('button', { name: 'Écouter ce son' }).first().click()
  assert.ok((await page.evaluate(() => window.__notes)) > before, 'The test button plays')
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(shots, 'qol-sounds-settings.png'), fullPage: true })
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('sillage.sounds'))).enabled, true)

  // --- A decision away from the viewed page: tab count, icon dot and a sound -------------------
  await page.goto(`${base}/p/${hero.projectId}/board`)
  await page.getByRole('heading', { name: 'Board' }).waitFor()
  const project = db.prepare('SELECT id, owner_id AS ownerId FROM projects WHERE id = ?').get(hero.projectId)
  const now = Date.now()
  db.prepare(
    `INSERT INTO scheduled_tasks (id, project_id, user_id, name, agent, config, prompt, cadence, execution_mode, overlap_policy,
       max_duration_minutes, enabled, decisions_enabled, decision_max_hours, created_at, updated_at)
     VALUES ('task', ?, ?, 'Veille', 'codex', '{}', 'p', '{"kind":"interval","minutes":1440}', 'fresh', 'skip', 30, 0, 1, 24, ?, ?)`,
  ).run(project.id, project.ownerId, now, now)
  const session = randomUUID()
  db.prepare(
    `INSERT INTO conversations (id, project_id, user_id, title, agent, config, status, schedule_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Veille · 27/11', 'codex', '{}', 'idle', 'task', ?, ?)`,
  ).run(session, project.id, project.ownerId, now, now)
  const waiting = () => page.evaluate(() => Number(/^\((\d+)\) /.exec(document.title)?.[1] ?? 0))
  const waitingBefore = await waiting()
  const notesBefore = await page.evaluate(() => window.__notes)
  db.prepare("INSERT INTO agent_requests (id, project_id, conversation_id, kind, payload, created_at) VALUES (?, ?, ?, 'request_decision', ?, ?)")
    .run(randomUUID(), project.id, session, JSON.stringify({ question: 'Publier la 2.0 ?', options: ['Oui', 'Non'] }), Date.now())
  await page.waitForFunction((count) => document.title.startsWith(`(${count}) `), waitingBefore + 1, { timeout: 15000 })
  assert.match(await page.locator('link[rel="icon"]').first().getAttribute('href'), /^data:image\/svg\+xml/, 'The icon carries a dot')
  await page.waitForFunction((count) => window.__notes > count, notesBefore, { timeout: 5000 })
  await page.screenshot({ path: join(shots, 'qol-tab-title.png') })

  // Muted from the palette: the next decision is silent.
  await page.keyboard.press('Control+k')
  await page.getByRole('dialog').getByRole('combobox').fill('couper les sons')
  await page.getByRole('option', { name: /Couper les sons/ }).click()
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('sillage.sounds'))).enabled, false)
  const muted = await page.evaluate(() => window.__notes)
  // A second session: one asks one question at a time.
  const second = randomUUID()
  db.prepare(
    `INSERT INTO conversations (id, project_id, user_id, title, agent, config, status, schedule_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Veille · 28/11', 'codex', '{}', 'idle', 'task', ?, ?)`,
  ).run(second, project.id, project.ownerId, now, now)
  db.prepare("INSERT INTO agent_requests (id, project_id, conversation_id, kind, payload, created_at) VALUES (?, ?, ?, 'request_decision', ?, ?)")
    .run(randomUUID(), project.id, second, JSON.stringify({ question: 'Et la 2.1 ?', options: ['Oui', 'Non'] }), Date.now())
  await page.waitForFunction((count) => document.title.startsWith(`(${count}) `), waitingBefore + 2, { timeout: 15000 })
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => window.__notes), muted, 'Muted: no sound')

  // --- Phone: the paste chip and the sounds page fit ------------------------------------------
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block', storageState: await context.storageState() })
  await phone.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const mobile = await phone.newPage()
  mobile.on('pageerror', (error) => errors.push(error.message))
  await mobile.goto(`${base}/p/${hero.projectId}/c/${hero.id}`)
  const mobileField = mobile.locator('form textarea').first()
  await mobileField.waitFor()
  await mobileField.evaluate((node, text) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', text)
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, long)
  await mobile.getByRole('link', { name: /texte-colle-60-lignes\.txt/ }).waitFor({ timeout: 10000 })
  await mobile.waitForTimeout(300)
  await mobile.screenshot({ path: join(shots, 'qol-phone-paste.png') })
  await mobile.goto(`${base}/settings/sons`)
  await mobile.getByRole('switch', { name: 'Sons sur cet appareil' }).waitFor()
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `The sounds page fits a phone (overflow ${overflow}px)`)
  await mobile.screenshot({ path: join(shots, 'qol-phone-sounds.png'), fullPage: true })
  await phone.close()

  assert.deepEqual(errors, [])
  console.log(`Confort : parcours complet vérifié. Captures dans ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
