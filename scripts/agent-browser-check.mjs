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

// Agent browser, end to end on a temporary demo instance: install the pinned Playwright MCP, call
// one of its tools as a CLI would (which launches Chromium through the daemon's CDP proxy), then
// watch the page live and click in it as a person taking over.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
const data = await mkdtemp(join(tmpdir(), 'sillage-agent-browser-check-'))
const shots = process.env.SILLAGE_CHECK_SHOTS ?? '/var/tmp/sillage-agent-browser-check'
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

  const api = `http://127.0.0.1:${apiPort}`
  const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'sillage-demo' }) })
  assert.ok(login.ok)
  const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
  const call = async (method, path, body) => {
    const response = await fetch(`${api}${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }

  // Install: pinned MCP server; the engine comes from the machine (Playwright cache here).
  let status = (await call('POST', '/api/browser/install')).body
  for (let i = 0; i < 600 && status.installing; i++) {
    await delay(500)
    status = (await call('GET', '/api/browser/status')).body
  }
  assert.equal(status.error, null, status.error)
  assert.ok(status.ready, JSON.stringify(status))
  console.log('engine', status.engine, 'mcp', status.mcp.version)

  const db = new Database(join(data, 'data', 'sillage.db'), { readonly: true })
  const conversation = db.prepare('SELECT id FROM conversations WHERE project_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get()
  db.close()
  const key = Buffer.from((await readFile(join(data, 'data', 'browser', 'key'), 'utf8')).trim(), 'hex')
  const endpoint = `ws://127.0.0.1:${apiPort}/api/browser-cdp/${conversation.id}?token=${createHmac('sha256', key).update(conversation.id).digest('hex')}`

  // A wrong token is refused before anything launches.
  const refused = await new Promise((resolve) => {
    const socket = new WebSocket(endpoint.replace(/token=\w+/, 'token=nope'))
    socket.addEventListener('close', (event) => resolve(event.code))
  })
  assert.equal(refused, 4401)

  // The agent side: Playwright MCP over stdio, as a CLI launches it.
  const mcp = spawn(process.execPath, [join(data, 'data', 'browser', 'mcp', 'node_modules', '@playwright', 'mcp', 'cli.js'), '--cdp-endpoint', endpoint], { stdio: ['pipe', 'pipe', 'pipe'] })
  processes.push(mcp)
  let buffer = ''
  const replies = new Map()
  mcp.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try { const message = JSON.parse(line); if (message.id !== undefined) replies.get(message.id)?.(message) } catch {}
    }
  })
  let mcpErr = ''
  mcp.stderr.on('data', (chunk) => { mcpErr = (mcpErr + chunk).slice(-3000) })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`${method} timed out: ${mcpErr}`)), 60000)
    replies.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result) })
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = await rpc('tools/list', {})
  assert.ok(tools.tools.some((tool) => tool.name === 'browser_navigate'))
  const site = createHttpServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<title>Check</title><button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:80px" onclick="document.title=\'clicked\'">Click</button>')
  }).listen(0, '127.0.0.1')
  await once(site, 'listening')
  processes.push({ kill: () => site.close() })
  const page = `http://127.0.0.1:${site.address().port}/`
  const navigated = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: page } })
  assert.notEqual(navigated.isError, true, JSON.stringify(navigated))

  // Tab titles follow DevTools target events, which trail the navigation a little.
  let list = []
  for (let i = 0; i < 50; i++) {
    list = (await call('GET', '/api/browsers')).body.browsers
    if (list[0]?.tabs.some((tab) => tab.title === 'Check')) break
    await delay(100)
  }
  assert.equal(list.length, 1)
  assert.equal(list[0].conversationId, conversation.id)
  assert.equal(list[0].agentConnected, true)
  assert.ok(list[0].tabs.some((tab) => tab.title === 'Check'), JSON.stringify(list[0].tabs))

  // The person's side: live frames, then a click that the page receives.
  const live = new WebSocket(`ws://127.0.0.1:${apiPort}/api/conversations/${conversation.id}/browser/live`, { headers: { cookie } })
  const frames = []
  let state = null
  live.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.t === 'frame') frames.push(message)
    if (message.t === 'state') state = message
    if (message.t === 'error') console.error('live error', message)
  })
  await once(live, 'open')
  for (let i = 0; i < 100 && frames.length === 0; i++) await delay(100)
  assert.ok(frames.length > 0, 'no live frame')
  assert.ok(frames[0].width >= 800, JSON.stringify({ width: frames[0].width, height: frames[0].height }))
  assert.ok(state?.browser && state.watching)
  for (const [index, frame] of frames.entries()) await writeFile(join(shots, `live-frame-${index}.jpg`), Buffer.from(frame.data, 'base64'))
  console.log(frames.map((frame) => `${frame.width}x${frame.height}`).join(' '))
  for (const type of ['mousePressed', 'mouseReleased']) live.send(JSON.stringify({ t: 'mouse', type, x: 200, y: 140, button: 'left', clickCount: 1 }))
  let clicked = false
  for (let i = 0; i < 50 && !clicked; i++) {
    await delay(100)
    clicked = (await call('GET', '/api/browsers')).body.browsers[0].tabs.some((tab) => tab.title === 'clicked')
  }
  assert.ok(clicked, 'the click did not reach the page')

  // Closing from the interface ends the browser.
  live.close()
  mcp.kill()
  assert.equal((await call('DELETE', `/api/conversations/${conversation.id}/browser`)).status, 204)
  assert.equal((await call('GET', '/api/browsers')).body.browsers.length, 0)
  console.log(`ok — ${frames.length} frames, capture in ${shots}`)
} finally {
  for (const child of processes) child.kill()
  await delay(500)
  await rm(data, { recursive: true, force: true, maxRetries: 5 }).catch((err) => console.error('cleanup:', err.message))
}
