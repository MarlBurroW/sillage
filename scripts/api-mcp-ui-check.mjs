import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Check settings show API/MCP side by side, create an MCP token without task-only
// fields, then open the real MCP server with that token.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-api-mcp-check-'))
const shots = process.env.API_MCP_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-api-mcp-shots-')))
const processes = []
let browser
const unit = `sillage-app-api-mcp-check-${process.pid}`

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
  const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: join(data, 'web') }
  const server = spawn('systemd-run', ['--user', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--working-directory=${serverDir}`,
    ...Object.entries(env).filter(([key]) => key.startsWith('SILLAGE_') || ['PATH', 'NODE_ENV'].includes(key)).map(([key, value]) => `--setenv=${key}=${value}`),
    process.execPath, '--import', 'tsx', 'src/main.ts'], { stdio: 'pipe' })
  server.diagnostics = ''
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { server.diagnostics += chunk })
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [code] = await once(seed, 'exit')
  assert.equal(code, 0, seed.diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    await page.goto(`${base}/settings/api`)
    await page.getByRole('heading', { name: 'API et serveur MCP' }).waitFor()
    // Both entry points, each with its address.
    await page.getByRole('heading', { name: 'API REST', exact: true }).waitFor()
    await page.getByRole('heading', { name: 'Serveur MCP', exact: true }).waitFor()
    assert.ok(await page.getByText(`${base}/api/v1`, { exact: true }).isVisible())
    assert.ok(await page.getByText(`${base}/api/v1/mcp`, { exact: true }).first().isVisible())
    // Collapsed guide on MCP card contains a placeholder instead of token.
    await page.getByText('Brancher un client MCP', { exact: true }).click()
    assert.ok(await page.getByText('Authorization: Bearer <jeton>', { exact: true }).isVisible())
    await page.screenshot({ path: join(shots, `${name}-surfaces.png`), fullPage: true })

    await page.getByRole('button', { name: 'Créer un jeton MCP', exact: true }).click()
    await page.getByRole('heading', { name: 'Nouveau jeton MCP' }).waitFor()
    assert.ok(await page.getByRole('checkbox', { name: /^mcp/ }).isChecked())
    assert.equal(await page.getByRole('checkbox', { name: /tasks:write/ }).isChecked(), false)
    // Without task scope, no CLI/webhook: they would configure nothing.
    assert.equal(await page.getByText('Ni CLI ni modèle à choisir', { exact: false }).isVisible(), true)
    assert.equal(await page.getByRole('textbox', { name: 'URL de webhook' }).count(), 0)
    // Selecting task scope brings them back.
    await page.getByRole('checkbox', { name: /tasks:write/ }).check()
    assert.equal(await page.getByRole('textbox', { name: 'URL de webhook' }).count(), 1)
    await page.getByRole('checkbox', { name: /tasks:write/ }).uncheck()
    await page.screenshot({ path: join(shots, `${name}-form.png`), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }

  await page.getByRole('textbox', { name: 'Nom', exact: true }).fill('Codex portable')
  const created = page.waitForResponse(response => response.url().endsWith('/api/tokens') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Créer le jeton', exact: true }).click()
  const tokenResponse = await created
  assert.equal(tokenResponse.status(), 201, await tokenResponse.text())
  const token = await tokenResponse.json()
  assert.deepEqual(token.token.scopes, ['mcp'])
  assert.equal(token.token.webhookUrl, null)
  // Token appears with connection guide applicable to every MCP client.
  const reveal = page.locator('.surface', { has: page.getByRole('heading', { name: 'Votre jeton', exact: true }) })
  await reveal.getByText('Sillage parle le protocole MCP standard', { exact: false }).waitFor()
  assert.ok(await reveal.getByText(`Authorization: Bearer ${token.secret}`, { exact: true }).isVisible())
  assert.ok(await reveal.getByText('HTTP « streamable »', { exact: false }).isVisible())
  // Examples start collapsed and contain token once opened.
  await reveal.getByText('Exemples', { exact: true }).click()
  assert.ok(await reveal.getByText(`http_headers = { "Authorization" = "Bearer ${token.secret}" }`, { exact: false }).isVisible())
  assert.ok(await reveal.getByText('"mcpServers"', { exact: false }).isVisible())
  await page.screenshot({ path: join(shots, 'phone-secret.png'), fullPage: true })
  // CLI controls only tasks: MCP-only tokens show none.
  assert.equal(await page.locator('main').getByText('claude', { exact: true }).count(), 0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: join(shots, 'desktop-secret.png'), fullPage: true })

  // Token opens real MCP server and nothing else.
  const headers = { authorization: `Bearer ${token.secret}` }
  const rpc = (body, session) => context.request.post(`${base}/api/v1/mcp`, { headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) }, data: body })
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } } })
  assert.equal(init.status(), 200, await init.text())
  const session = init.headers()['mcp-session-id']
  assert.ok(session)
  const listed = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }, session)).json()
  assert.match(listed.result.content[0].text, /projet\(s\)/)
  assert.equal((await context.request.get(`${base}/api/v1/projects`, { headers })).status(), 403)

  // Link from agent-provided servers to Sillage's server.
  await page.goto(`${base}/settings/mcp`)
  // Use paragraph link, not same-named settings-navigation link.
  const pointer = page.locator('p', { hasText: 'Ce sont des serveurs que vos agents utilisent' })
  await pointer.waitFor()
  await pointer.getByRole('link', { name: 'API et MCP' }).click()
  await page.waitForURL(`${base}/settings/api`)
  assert.deepEqual(errors, [])
  console.log(`api-mcp-ui-check: ok — captures dans ${shots}`)
} finally {
  await browser?.close()
  execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
