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

// Usage limit stop and resume as the user sees them: the settings page (desktop and phone), the
// notification preference, and the thread notices journaled by the resume service. The journal
// is written directly: provoking a real subscription limit is not an option.
// Screenshots go to USAGE_LIMIT_SHOTS or a temporary directory.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-usage-limit-check-'))
const shots = process.env.USAGE_LIMIT_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-usage-limit-shots-')))
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

/** Appends journal events the way the resume service does, from a second process on the same database. */
async function journal(env, conversationId, events) {
  const script = `
    import { openDatabase } from '@sillage/db'
    import { EventLog } from './src/events/event-log.js'
    const { db, sqlite } = openDatabase(${JSON.stringify(join(env.SILLAGE_DATA_DIR, 'sillage.db'))})
    const log = new EventLog(db)
    for (const event of ${JSON.stringify(events)}) log.append(${JSON.stringify(conversationId)}, event)
    sqlite.close()
  `
  // Written inside apps/server so workspace packages resolve; removed right after.
  const file = join(serverDir, `.usage-limit-check-${process.pid}.mts`)
  await writeFile(file, script)
  try {
    const child = run(['--import', 'tsx', file], serverDir, env)
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, child.diagnostics)
  } finally {
    await rm(file, { force: true })
  }
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
  const conversation = (await api(`/api/projects/${project.id}/conversations`))[0]
  assert.ok(conversation, 'Nimbus has a demo conversation')

  // Settings: default off, saved form, preference under Notifications.
  const settings = await api('/api/me/settings')
  assert.deepEqual(settings.usageLimitResume, { enabled: false, maxHours: 12, message: '' })
  assert.equal(settings.notifications.usageLimit, true)

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/settings/limites`)
  await page.getByText('Reprise automatique').waitFor()
  const save = page.getByRole('button', { name: 'Enregistrer' })
  assert.ok(await save.isDisabled(), 'Nothing to save at first')
  await page.getByLabel('Reprendre les sessions arrêtées une fois la limite levée').check()
  await page.getByLabel(/plus de \(heures\)/).fill('6')
  await page.locator('#usage-limit-message').fill('Reprends là où tu en étais et termine la carte en cours.')
  await page.screenshot({ path: join(shots, 'usage-limit-settings-desktop.png') })
  await save.click()
  await page.getByText('Enregistré.').waitFor()
  const saved = await api('/api/me/settings')
  assert.deepEqual(saved.usageLimitResume, { enabled: true, maxHours: 6, message: 'Reprends là où tu en étais et termine la carte en cours.' })

  await page.goto(`${base}/settings/notifications`)
  await page.getByText("Limite d'usage atteinte").waitFor()
  await page.screenshot({ path: join(shots, 'usage-limit-notification-pref.png') })

  // Thread: the two notices the service journals, with resume scheduled or not.
  const resetsAt = Date.now() + 42 * 60_000
  await journal(env, conversation.id, [
    { type: 'turn.started' },
    { type: 'error', code: 'turn_failed', message: "You've hit your limit · resets 3pm (Europe/Paris)", recoverable: true },
    { type: 'turn.completed', stopReason: 'success', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    { type: 'agent.notice', code: 'usage_limit_stop', message: 'The usage limit stopped this turn.', level: 'warning', details: { resetsAt, resumeAt: resetsAt + 60_000, reason: null } },
    { type: 'agent.notice', code: 'usage_limit_stop', message: 'The usage limit stopped this turn.', level: 'warning', details: { resetsAt: resetsAt + 30 * 3_600_000, resumeAt: null, reason: 'threshold' } },
    { type: 'agent.notice', code: 'usage_limit_resumed', message: 'Sillage resumed the session after the usage limit lifted.', level: 'info' },
  ])
  await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  await page.getByText(/Sillage reprend cette session à/).waitFor()
  await page.getByText(/au-delà de ton seuil/).waitFor()
  await page.getByText("Sillage a repris la session après la levée de la limite d'usage").waitFor()
  await page.screenshot({ path: join(shots, 'usage-limit-thread.png') })

  // Phone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await phone.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  assert.ok((await phone.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const small = await phone.newPage()
  small.on('pageerror', (error) => errors.push(error.message))
  await small.goto(`${base}/settings/limites`)
  await small.getByText('Reprise automatique').waitFor()
  await small.screenshot({ path: join(shots, 'usage-limit-settings-phone.png'), fullPage: true })
  await small.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  await small.getByText(/Sillage reprend cette session à/).waitFor()
  await small.screenshot({ path: join(shots, 'usage-limit-thread-phone.png') })

  assert.deepEqual(errors, [])
  console.log(`OK — screenshots in ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
