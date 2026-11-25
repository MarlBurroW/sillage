import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Dev-server previews end to end on a temporary demo instance: a real Vite dev server run as an
// agent's sillage-app unit, opened through the preview listener (sign-in link, cookie, proxied
// pages, hot reload over WebSocket), then the panel's Preview tab, the Services shortcut and the
// settings page at 1440 and 390 px. Needs Vite in /var/tmp/preview-probe/app (any vanilla
// template; only its node_modules are used).
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
const data = await mkdtemp(join(tmpdir(), 'sillage-dev-previews-check-'))
const shots = process.env.SILLAGE_CHECK_SHOTS ?? '/var/tmp/sillage-dev-previews-check'
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

const units = []
try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const previewPort = await freePort()
  const vitePort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, `[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n[previews]\ndomain = "preview.test"\nport = ${previewPort}\n`)
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
    // The web dev server answers the test host the preview frame shares a site with.
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'app.preview.test',
  }
  let server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(`http://127.0.0.1:${webPort}`, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  // An origin token for the first project, read by the server at start like an agent's.
  server.kill()
  await once(server, 'exit')
  const db = new Database(join(data, 'data', 'sillage.db'), { readonly: true })
  const project = db.prepare("SELECT p.id, p.name FROM projects AS p JOIN users AS u ON u.id = p.owner_id WHERE u.username = 'alex' ORDER BY p.position LIMIT 1").get()
  const conversation = db.prepare("SELECT id FROM conversations WHERE project_id = ? AND archived_at IS NULL AND schedule_id IS NULL ORDER BY updated_at DESC LIMIT 1").get(project.id)
  db.close()
  const token = randomUUID()
  await mkdir(join(data, 'data', 'process-origins'), { recursive: true })
  await writeFile(join(data, 'data', 'process-origins', `${token}.json`), JSON.stringify({ projectId: project.id, conversationId: conversation.id }))
  server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  await ready(`http://127.0.0.1:${apiPort}/api/health`, server)

  // The dev server, as an agent starts a permanent app.
  const app = join(data, 'fixture')
  await mkdir(join(app, 'src'), { recursive: true })
  await symlink('/var/tmp/preview-probe/app/node_modules', join(app, 'node_modules'))
  await writeFile(join(app, 'index.html'), '<!doctype html><title>Fixture</title><h1 id="t">Preview v1</h1><script type="module" src="/src/main.js"></script>')
  await writeFile(join(app, 'src', 'main.js'), "document.querySelector('#t').dataset.ready = 'yes'\n")
  const unit = `sillage-app-pvcheck-${token.slice(0, 8)}`
  units.push(`${unit}.service`)
  await promisify(execFile)('systemd-run', ['--user', '--collect', `--unit=${unit}`, `--setenv=SILLAGE_PROCESS_ORIGIN=${token}`, `--working-directory=${app}`,
    process.execPath, join(app, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'])
  for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${vitePort}/`).then((r) => r.ok, () => false)); i++) await delay(200)

  const api = `http://127.0.0.1:${apiPort}`
  const login = await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'sillage-demo' }) })
  const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
  const call = async (method, path, body) => {
    const response = await fetch(`${api}${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, body: await response.json() }
  }
  let list
  for (let i = 0; i < 50; i++) {
    list = (await call('GET', '/api/previews')).body
    if (list.targets.some((target) => target.port === vitePort)) break
    await delay(300)
  }
  assert.equal(list.mode, 'proxy')
  assert.equal(list.listenerPort, previewPort)
  const target = list.targets.find((entry) => entry.port === vitePort)
  assert.ok(target, JSON.stringify(list))
  assert.equal(target.projectId, project.id)
  assert.ok(!list.targets.some((entry) => entry.port === apiPort), 'Sillage itself is never a target')
  assert.equal((await call('POST', '/api/previews', { port: apiPort })).status, 404)
  const opened = (await call('POST', '/api/previews', { port: vitePort })).body
  assert.match(opened.url, /^http:\/\/pv-[0-9a-f]{12}\.preview\.test\/__sillage\/preview-sign-in\?t=/)
  const host = new URL(opened.address).host

  // Raw requests to the preview listener, as the reverse proxy sends them.
  const raw = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: previewPort, path, headers: { host, ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal((await raw('/')).status, 401, 'no cookie, no page')
  assert.equal((await raw('/', { host: 'pv-000000000000.preview.test' })).status, 404, 'unknown preview')
  const signIn = await raw(new URL(opened.url).pathname + new URL(opened.url).search)
  assert.equal(signIn.status, 302)
  const previewCookie = signIn.headers['set-cookie'][0].split(';')[0]
  assert.match(signIn.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/)
  assert.equal((await raw(new URL(opened.url).pathname + new URL(opened.url).search)).status, 302, 'link reusable within its minute')
  const page = await raw('/', { cookie: previewCookie })
  assert.equal(page.status, 200)
  assert.match(page.body, /Preview v1/)
  assert.match(page.body, /\/@vite\/client/)
  const client = await raw('/@vite/client', { cookie: previewCookie })
  const wsToken = /const wsToken = "([^"]+)"/.exec(client.body)?.[1]
  assert.ok(wsToken, 'Vite client token')
  const upgrade = await new Promise((resolve, reject) => {
    const socket = connect(previewPort, '127.0.0.1', () => {
      socket.write(`GET /?token=${wsToken} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${previewCookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: vite-hmr\r\nOrigin: http://${host}\r\n\r\n`)
    })
    socket.once('data', (chunk) => { resolve(chunk.toString().split('\r\n')[0]); socket.destroy() })
    socket.on('error', reject)
  })
  assert.match(upgrade, /101/, 'hot reload WebSocket through the proxy')

  // Public demo links: no sign-in, noindex, hot reload too; revoked and expired links are refused.
  const share = (await call('POST', '/api/previews/shares', { port: vitePort, hours: 1 })).body
  assert.match(share.url, /^http:\/\/pv-[0-9a-f]{16}\.preview\.test\/$/)
  assert.equal(share.label, 'node')
  const shareHost = new URL(share.url).host
  const visitor = await raw('/', { host: shareHost })
  assert.equal(visitor.status, 200, 'a visitor without Sillage gets the app')
  assert.match(visitor.body, /Preview v1/)
  assert.equal(visitor.headers['x-robots-tag'], 'noindex, nofollow')
  const visitorSocket = await new Promise((resolve, reject) => {
    const socket = connect(previewPort, '127.0.0.1', () => {
      socket.write(`GET /?token=${wsToken} HTTP/1.1\r\nHost: ${shareHost}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`)
    })
    socket.once('data', (chunk) => { resolve(chunk.toString().split('\r\n')[0]); socket.destroy() })
    socket.on('error', reject)
  })
  assert.match(visitorSocket, /101/)
  assert.equal((await call('POST', '/api/previews/shares', { port: apiPort, hours: 1 })).status, 404, 'Sillage itself cannot be shared')
  assert.equal((await call('POST', '/api/previews/shares', { port: vitePort, hours: 2 })).status, 400, 'only offered lifetimes')
  const listed = (await call('GET', '/api/previews/shares')).body.shares
  assert.equal(listed.length, 1)
  assert.equal((await fetch(`${api}/api/previews/shares/${share.id}`, { method: 'DELETE', headers: { cookie } })).status, 204)
  assert.equal((await raw('/', { host: shareHost })).status, 410, 'revoked')
  const expiring = (await call('POST', '/api/previews/shares', { port: vitePort, hours: 24 })).body
  const writable = new Database(join(data, 'data', 'sillage.db'))
  writable.prepare('UPDATE preview_shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, expiring.id)
  writable.close()
  assert.equal((await raw('/', { host: new URL(expiring.url).host })).status, 410, 'expired')
  const demo = (await call('POST', '/api/previews/shares', { port: vitePort, hours: 168 })).body

  // The interface, with the preview hosts resolved to the listener and the app on the same site.
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP app.preview.test 127.0.0.1:${webPort}, MAP *.preview.test 127.0.0.1:${previewPort}`] })
  const errors = []
  const base = 'http://app.preview.test'
  try {
    let first = true
    for (const [name, viewport, mobile] of [['desktop', { width: 1440, height: 1000 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', colorScheme: theme, serviceWorkers: 'block' })
        const page = await context.newPage()
        page.on('pageerror', (error) => errors.push(`${name}/${theme}: ${error.message}`))
        // Signed in from the page: only the browser resolves the test hosts.
        await page.goto(`${base}/api/health`)
        assert.equal(await page.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'sillage-demo' }) })).status), 200)
        await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
        await page.getByRole('button', { name: 'Ouvrir le panneau' }).first().click({ timeout: 60000 })
        // The tab's name carries its count ("Aperçu, 1").
        const tab = page.getByRole('button', { name: /^Aperçu\b/ }).first()
        await tab.waitFor({ timeout: 15000 }).catch(async (error) => {
          await page.screenshot({ path: join(shots, 'failure.png') })
          console.error('previews seen by the page:', JSON.stringify((await page.evaluate(async () => (await fetch('/api/previews')).json())).targets.filter((t) => t.projectId)))
          console.error('tabs:', await page.locator('nav button[aria-label]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label'))))
          throw error
        })
        await tab.click()
        const frame = page.frameLocator('[data-preview-frame]')
        await frame.locator('#t[data-ready="yes"]').waitFor({ timeout: 30000 }).catch(async (error) => {
          await page.screenshot({ path: join(shots, 'failure-frame.png') })
          console.error('frame src:', await page.locator('[data-preview-frame]').getAttribute('src').catch(() => 'none'))
          console.error('frame body:', await frame.locator('body').innerText().catch((e) => 'unreadable ' + e.message))
          throw error
        })
        if (first) {
          // Hot reload through the proxy: an edit reaches the open frame without reloading Sillage.
          await writeFile(join(app, 'index.html'), '<!doctype html><title>Fixture</title><h1 id="t">Preview v2</h1><script type="module" src="/src/main.js"></script>')
          await frame.getByText('Preview v2').waitFor({ timeout: 20000 })
          first = false
        }
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(shots, `panel-${name}-${theme}.png`) })
        // The demo link window lists the active link and makes another.
        await page.getByRole('button', { name: 'Lien de démo' }).click()
        const dialog = page.locator('[data-preview-share-dialog]')
        await dialog.getByText(demo.url).waitFor()
        if (name === 'desktop' && theme === 'light') {
          await dialog.getByRole('button', { name: 'Créer un lien' }).click()
          await page.waitForFunction(() => document.querySelectorAll('[data-preview-share]').length >= 3)
        }
        await page.screenshot({ path: join(shots, `share-${name}-${theme}.png`) })
        await page.keyboard.press('Escape')

        await page.goto(`${base}/services`)
        await page.getByRole('button', { name: `Aperçu du port ${vitePort}` }).first().waitFor()
        await page.screenshot({ path: join(shots, `services-${name}-${theme}.png`) })
        await page.goto(`${base}/settings/apercus`)
        await page.getByLabel('Domaine').waitFor()
        await page.waitForFunction(() => document.querySelector('input[placeholder="example.com"]')?.value === 'preview.test')
        await page.screenshot({ path: join(shots, `settings-${name}-${theme}.png`) })
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  assert.deepEqual(errors, [])

  // A link outlives its dev server only as a refusal: once the port is gone, nothing is served,
  // even if something else takes the port later (checked again after at most 30 s).
  await promisify(execFile)('systemctl', ['--user', 'stop', `${unit}.service`])
  await delay(31_000)
  const stopped = await raw('/', { host: new URL(demo.url).host })
  assert.equal(stopped.status, 410)
  assert.match(stopped.body, /not running/)
  console.log(`ok — captures in ${shots}`)
} finally {
  for (const unit of units) await promisify(execFile)('systemctl', ['--user', 'stop', unit]).catch(() => {})
  for (const child of processes) child.kill()
  await delay(300)
  await rm(data, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}
