import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

// Agent browser interface on a temporary demo instance: the thread shortcut on a browser tool call,
// the conversation panel's Browser tab (live view, takeover), and the Browsers tab of Services, on
// a large screen and a phone. The browser itself is opened by Playwright MCP, as an agent would.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
const data = await mkdtemp(join(tmpdir(), 'sillage-agent-browser-ui-check-'))
const shots = process.env.SILLAGE_CHECK_SHOTS ?? '/var/tmp/sillage-agent-browser-ui-check'
const processes = []

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

  const projects = await (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).ok
  assert.ok(projects)
  await mkdir(shots, { recursive: true })

  // A browser tool call in a thread, as Claude names it, written with the server stopped.
  server.kill()
  await once(server, 'exit')
  const db = new Database(join(data, 'data', 'sillage.db'))
  const conversation = db.prepare("SELECT c.id, c.project_id AS projectId FROM conversations AS c WHERE c.project_id IS NOT NULL AND c.status = 'idle' AND c.schedule_id IS NULL AND c.archived_at IS NULL AND EXISTS (SELECT 1 FROM events AS e WHERE e.conversation_id = c.id) ORDER BY c.updated_at DESC LIMIT 1").get()
  let seq = db.prepare('SELECT max(seq) AS seq FROM events WHERE conversation_id = ?').get(conversation.id).seq
  const insert = (payload) => db.prepare('INSERT INTO events (conversation_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(conversation.id, ++seq, Date.now(), payload.type, JSON.stringify(payload))
  insert({ type: 'tool.started', toolCallId: 'browser-check', name: 'mcp__sillage-browser__browser_navigate', input: { url: 'http://example.test/' }, parentToolCallId: null })
  insert({ type: 'tool.completed', toolCallId: 'browser-check', output: 'Navigated', isError: false, durationMs: 420 })
  db.prepare('UPDATE conversations SET last_seq = ? WHERE id = ?').run(seq, conversation.id)
  db.close()
  server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  await ready(`http://127.0.0.1:${apiPort}/api/health`, server)

  const api = `http://127.0.0.1:${apiPort}`
  const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'sillage-demo' }) })
  const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
  const call = async (method, path, body) => {
    const response = await fetch(`${api}${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  let status = (await call('POST', '/api/browser/install')).body
  for (let i = 0; i < 600 && status.installing; i++) { await delay(500); status = (await call('GET', '/api/browser/status')).body }
  assert.ok(status.ready, JSON.stringify(status))
  assert.equal((await call('PATCH', '/api/settings', { agentTools: { browser: true } })).status, 200)

  // The agent opens a page through Playwright MCP.
  const site = createHttpServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<title>Login</title><body style="font:20px sans-serif"><h1 style="position:absolute;left:40px;top:20px;margin:0">Sign in</h1><input id="name" placeholder="Name" style="position:absolute;left:40px;top:100px;width:200px;height:40px;font-size:20px"><button id="b" style="position:absolute;left:260px;top:100px;height:40px;font-size:20px" onclick="document.title=\'hello \'+document.getElementById(\'name\').value">Continue</button></body>')
  }).listen(0, '127.0.0.1')
  await once(site, 'listening')
  processes.push({ kill: () => site.close() })
  const key = Buffer.from((await readFile(join(data, 'data', 'browser', 'key'), 'utf8')).trim(), 'hex')
  const endpoint = `ws://127.0.0.1:${apiPort}/api/browser-cdp/${conversation.id}?token=${createHmac('sha256', key).update(conversation.id).digest('hex')}`
  // As in production (browser/manager.ts): without an output directory the MCP writes its
  // snapshots into `.playwright-mcp/` under the current directory, the repository here.
  const mcp = spawn(process.execPath, [join(data, 'data', 'browser', 'mcp', 'node_modules', '@playwright', 'mcp', 'cli.js'), '--cdp-endpoint', endpoint, '--output-dir', join(data, 'mcp-output')], { stdio: ['pipe', 'pipe', 'pipe'] })
  processes.push(mcp)
  let buffer = ''
  const replies = new Map()
  mcp.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      try { const message = JSON.parse(line); if (message.id !== undefined) replies.get(message.id)?.(message) } catch {}
    }
  })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60000)
    replies.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result) })
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const navigated = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${site.address().port}/` } })
  assert.notEqual(navigated.isError, true, JSON.stringify(navigated))

  const browser = await chromium.launch()
  const errors = []
  let first = true
  try {
    for (const [name, viewport, mobile] of [['desktop', { width: 1440, height: 1000 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', colorScheme: theme, serviceWorkers: 'block' })
        assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
        const page = await context.newPage()
        page.on('pageerror', (error) => errors.push(`${name}/${theme}: ${error.message}`))

        // Thread shortcut → panel Browser tab with the live page.
        await page.goto(`${base}/p/${conversation.projectId}/c/${conversation.id}`)
        // The line above the composer says a browser is open, whatever opened it.
        const reminder = page.locator('[data-browser-activity]')
        await reminder.waitFor({ timeout: 60000 })
        assert.match(await reminder.innerText(), /L'agent utilise un navigateur/)
        const shortcut = page.getByRole('button', { name: 'Voir le navigateur' }).last()
        await shortcut.waitFor({ timeout: 60000 })
        await shortcut.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(shots, `thread-${name}-${theme}.png`) })
        await shortcut.click()
        const view = page.locator('[data-browser-view] img')
        await view.waitFor({ timeout: 30000 })
        await page.waitForTimeout(500)
        await page.screenshot({ path: join(shots, `panel-${name}-${theme}.png`) })

        if (first) {
          // Take over: type a name and press the button, as a person finishing a login would.
          // The view takes the panel's initial focus, so the close button's tooltip does not cover the toolbar.
          assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-browser-view')), true)
          await page.getByRole('button', { name: 'Prendre la main' }).click()
          const box = await view.boundingBox()
          const frame = await view.evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight }))
          // The page places its field at fixed page pixels; map them through the letterboxed image.
          const scale = Math.min(box.width / frame.w, box.height / frame.h)
          const left = box.x + (box.width - frame.w * scale) / 2
          const top = box.y + (box.height - frame.h * scale) / 2
          await page.mouse.click(left + 140 * scale, top + 120 * scale)
          await page.keyboard.type('Ada')
          await page.keyboard.press('Enter')
          await page.screenshot({ path: join(shots, `control-${name}-${theme}.png`) })
          await page.locator('[data-browser-view]').focus()
          const snapshot = await rpc('tools/call', { name: 'browser_snapshot', arguments: {} })
          const text = JSON.stringify(snapshot)
          assert.match(text, /Ada/, 'typed text did not reach the page')
          await page.getByRole('button', { name: "Rendre la main à l'agent" }).click()
          first = false
        }

        // Services › Navigateurs lists it.
        await page.goto(`${base}/services`)
        await page.getByRole('tab', { name: /Navigateurs/ }).click()
        await page.getByRole('button', { name: 'Regarder en direct' }).first().waitFor()
        assert.equal(await page.getByRole('tab', { name: /Navigateurs/ }).getAttribute('aria-selected'), 'true')
        // Tab underlines fade over 150 ms.
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(shots, `services-${name}-${theme}.png`) })
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  assert.deepEqual(errors, [])
  console.log(`ok — captures in ${shots}`)
} finally {
  for (const child of processes) child.kill()
  await delay(500)
  await rm(data, { recursive: true, force: true, maxRetries: 5 }).catch((err) => console.error('cleanup:', err.message))
}
