import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// “Act on my other projects”: the project setting, and a message from another project's
// session showing where it comes from. Real server and web on a temporary demo database.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
const data = await mkdtemp(join(tmpdir(), 'sillage-cross-projects-check-'))
const shots = process.env.SILLAGE_CHECK_SHOTS ?? '/var/tmp/sillage-cross-projects-check'
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
  for (let i = 0; i < 300; i++) {
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
  let server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  // A message from a session of another project, as the relay frames it. Written with the server
  // stopped: the event log keeps each journal's position in memory.
  server.kill()
  await once(server, 'exit')
  const db = new Database(join(data, 'data', 'sillage.db'))
  const [home, other] = db.prepare('SELECT id, name FROM projects ORDER BY position LIMIT 2').all()
  assert.ok(home && other, 'the demo seed needs two projects')
  const recipient = db.prepare("SELECT c.id FROM conversations AS c WHERE c.project_id = ? AND c.status = 'idle' AND c.schedule_id IS NULL AND c.archived_at IS NULL AND EXISTS (SELECT 1 FROM events AS e WHERE e.conversation_id = c.id) ORDER BY c.updated_at DESC LIMIT 1").get(home.id)
  const sender = db.prepare('SELECT id, title FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1').get(other.id)
  const seq = db.prepare('SELECT max(seq) AS seq FROM events WHERE conversation_id = ?').get(recipient.id).seq + 1
  const envelope = `<sillage-session-message kind="message" from="${sender.id}" title="${sender.title}" agent="claude" project="${other.name}" message="m-check">\nWhich card did you close yesterday? Details in session:${sender.id}.\n</sillage-session-message>\n\n[Sillage note: hidden]`
  db.prepare('INSERT INTO events (conversation_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
    recipient.id, seq, Date.now(), 'message.completed',
    JSON.stringify({ type: 'message.completed', messageId: 'm-check', role: 'user', blocks: [{ type: 'text', text: envelope }], parentToolCallId: null }),
  )
  db.prepare('UPDATE conversations SET last_seq = ? WHERE id = ?').run(seq, recipient.id)
  db.close()
  server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  await ready(`http://127.0.0.1:${apiPort}/api/health`, server)

  browser = await chromium.launch()
  const errors = []
  for (const [name, viewport, mobile] of [['desktop', { width: 1440, height: 1000 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', colorScheme: theme, serviceWorkers: 'block' })
      const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
      assert.ok(login.ok())
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(`${name}/${theme}: ${error.message}`))

      // The setting lives with the agent tools it widens, in the project's Agents tab.
      await page.goto(`${base}/p/${home.id}?section=agents`)
      const toggle = page.getByRole('switch', { name: 'Agir sur mes autres projets' })
      await toggle.waitFor()
      const before = await toggle.getAttribute('aria-checked')
      if (name === 'desktop' && theme === 'light') {
        assert.equal(before, 'false')
        await toggle.click()
        await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Agir sur mes autres projets"]')?.getAttribute('aria-checked') === 'true')
        const projects = await (await context.request.get(`${base}/api/projects`)).json()
        assert.equal(projects.find((project) => project.id === home.id).crossProjects, true)
      }
      await toggle.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, `settings-${name}-${theme}.png`) })

      await page.goto(`${base}/p/${home.id}/c/${recipient.id}`)
      // The thread is shown once placed (as in performance-audit-browser.mjs).
      await page.locator('.sg-conversation-width.opacity-100').waitFor({ timeout: 60000 }).catch(async (error) => {
        await page.screenshot({ path: join(shots, 'failure.png') })
        const thread = await context.request.get(`${base}/api/conversations/${recipient.id}/thread`)
        console.error(thread.status(), (await thread.text()).slice(0, 600))
        throw error
      })
      // The thread's minimap repeats message text in hidden previews: look in the bubble.
      const bubble = page.locator('.sg-bubble', { hasText: 'Which card did you close yesterday?' })
      await bubble.waitFor()
      const peer = bubble
      await peer.scrollIntoViewIfNeeded()
      await bubble.getByText(`projet ${other.name}`).waitFor()
      // A reference to another project's session resolves instead of “unavailable”.
      assert.equal(await bubble.getByText('Session indisponible').count(), 0)
      assert.equal(await bubble.locator(`[data-session-reference="${sender.id}"] a`).getAttribute('href'), `/p/${other.id}/c/${sender.id}`)
      const link = bubble.getByRole('link', { name: sender.title }).first()
      assert.equal(await link.getAttribute('href'), `/p/${other.id}/c/${sender.id}`)
      // The thread fades in once placed.
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(shots, `message-${name}-${theme}.png`) })

      // The composer suggests the other project's sessions, naming their project.
      const composer = page.getByPlaceholder(/^Écris ton message/)
      await composer.click()
      await composer.pressSequentially(`@@${sender.title.split(' ')[0]}`)
      const picker = page.getByRole('listbox', { name: 'Sessions de tes projets' })
      await picker.waitFor()
      await picker.getByRole('option', { name: new RegExp(sender.title) }).waitFor()
      assert.match(await picker.getByRole('option', { name: new RegExp(sender.title) }).innerText(), new RegExp(other.name))
      await page.screenshot({ path: join(shots, `composer-${name}-${theme}.png`) })
      await composer.fill('')
      await context.close()
    }
  }
  assert.deepEqual(errors, [])
  console.log(`ok — captures in ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
