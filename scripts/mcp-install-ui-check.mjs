import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
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

// Agent-proposed MCP servers: the proposal lands in the conversation as a form, the secret typed
// there reaches the store and the entry gets the chosen scope. The proposal is deposited the way
// the Sillage MCP server does it (an `agent_requests` row) so no CLI runs; every agent is disabled
// in the disposable server so the follow-up message to the agent cannot start one.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-mcp-install-check-'))
const shots = process.env.MCP_INSTALL_SHOTS ?? await mkdtemp(join(tmpdir(), 'sillage-mcp-install-shots-'))
const processes = []
const units = []
let browser
let page

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}
function capture(child) {
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.diagnostics = (child.diagnostics + chunk).slice(-10000) })
  return child
}
function run(args, cwd, env) {
  const child = capture(spawn(process.execPath, args, { cwd, env, stdio: 'pipe' }))
  processes.push(child)
  return child
}
function service(name, env) {
  const unit = `sillage-app-mcp-install-${name}-${process.pid}`
  units.push(unit)
  return capture(spawn('systemd-run', ['--user', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--working-directory=${serverDir}`,
    ...Object.entries(env).filter(([key]) => key.startsWith('SILLAGE_') || ['PATH', 'NODE_ENV'].includes(key)).map(([key, value]) => `--setenv=${key}=${value}`),
    process.execPath, '--import', 'tsx', 'src/main.ts'], { stdio: 'pipe' }))
}
async function ready(url, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then(response => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok', 'antigravity'].map(agent => `[agents.${agent}]\nenabled = false\n`).join(''))
  const dataDir = join(data, 'server-data')
  const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: dataDir, SILLAGE_WEB_ROOT: join(data, 'web') }
  delete env.SILLAGE_PROFILE
  delete env.SILLAGE_HANDSHAKE_FD
  const server = service('server', env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  await context.request.patch(`${base}/api/me/settings`, { data: { onboarding: { pending: false } } })
  const project = (await (await context.request.get(`${base}/api/projects`)).json())[0]
  const conversation = (await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()).find(entry => entry.status === 'idle')
  assert.ok(conversation, 'the demo seed must provide an idle conversation')

  // Deposit the proposal exactly as `install_mcp_server` does; the daemon sweeps it within a second.
  const Database = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
  const db = new Database(join(dataDir, 'sillage.db'))
  // Conversation mode carries no account: the session identifies the requester, as in sillage-mcp.mjs.
  const propose = async (payload) => {
    const id = randomUUID()
    db.prepare('INSERT INTO agent_requests (id, project_id, conversation_id, user_id, kind, payload, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .run(id, project.id, conversation.id, 'install_mcp_server', JSON.stringify(payload), Date.now())
    for (let i = 0; i < 100; i++) {
      const row = db.prepare('SELECT settled_at AS settledAt, result, is_error AS isError FROM agent_requests WHERE id = ?').get(id)
      if (row?.settledAt) {
        assert.equal(row.isError, 0, row.result)
        return row.result
      }
      await delay(100)
    }
    throw new Error('the daemon did not process the proposal')
  }
  await propose({
    name: 'gh_issues',
    transport: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer {{secret.GITHUB_TOKEN}}' } },
    purpose: 'Lire les issues et les pull requests du dépôt depuis la conversation.',
    secret_hints: { GITHUB_TOKEN: 'github.com/settings/tokens, portée repo' },
  })

  page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const before = (await (await context.request.get(`${base}/api/mcp/servers`)).json()).servers.length
  await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  const title = page.getByText('L’agent propose d’installer le serveur MCP gh_issues')
  await title.waitFor({ timeout: 15000 })
  await page.getByText('Lire les issues et les pull requests').waitFor()
  // Every parameter the agent wrote is visible and editable.
  assert.equal(await page.getByRole('textbox', { name: 'Nom', exact: true }).inputValue(), 'gh_issues')
  assert.equal(await page.getByRole('textbox', { name: 'URL' }).inputValue(), 'https://api.githubcopilot.com/mcp/')
  assert.equal(await page.getByLabel('Valeur du jeton', { exact: true }).inputValue(), '{{secret.GITHUB_TOKEN}}')
  const secretField = page.getByLabel('GITHUB_TOKEN', { exact: true })
  assert.equal(await secretField.getAttribute('type'), 'password')
  await page.getByText('github.com/settings/tokens').waitFor()
  await page.getByRole('radio', { name: /Ce projet seulement/ }).waitFor()

  // The whole card, at both sizes; reload at phone size so the sidebar drawer closes.
  const card = () => title.locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]')
  for (const [label, viewport] of [['wide', { width: 1440, height: 1100 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport)
    await page.reload()
    await title.waitFor()
    await card().screenshot({ path: join(shots, `prompt-${label}.png`) })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: horizontal overflow`)
  }
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.reload()
  await title.waitFor()

  // Installing without the secret is refused by the browser's required field, so type it.
  await secretField.fill('ghp_typed_in_the_form')
  const installed = page.waitForResponse(response => response.url().includes('/mcp-installs/') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Installer', exact: true }).click()
  const answer = await installed
  assert.ok(answer.ok(), await answer.text())
  await page.getByText('Installé', { exact: true }).waitFor()
  await page.getByText(`Disponible dans toutes les conversations de ${project.name}.`).waitFor()
  await page.getByText('Serveur MCP gh_issues proposé par l’agent').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, 'installed.png') })

  const registry = await (await context.request.get(`${base}/api/mcp/servers`)).json()
  const github = registry.servers.find(entry => entry.name === 'gh_issues')
  assert.ok(github)
  assert.equal(github.projectId, project.id)
  assert.deepEqual(github.transport.headers, { Authorization: 'Bearer {{secret.GITHUB_TOKEN}}' })
  const secrets = await (await context.request.get(`${base}/api/secrets`)).json()
  assert.deepEqual(secrets.secrets.find(entry => entry.name === 'GITHUB_TOKEN')?.usedBy, ['gh_issues'])
  // The value is nowhere in the journal.
  const journal = db.prepare('SELECT payload FROM events WHERE conversation_id = ?').all(conversation.id).map(row => row.payload).join('\n')
  assert.doesNotMatch(journal, /ghp_typed_in_the_form/)
  assert.match(journal, /mcp_install\.resolved/)

  // Settings: one list, the project badge tells the scope.
  await page.goto(`${base}/settings/mcp`)
  await page.getByText(`Projet : ${project.name}`).waitFor()
  await page.screenshot({ path: join(shots, 'settings.png'), fullPage: true })

  // A second proposal, declined: nothing written.
  await propose({ name: 'slack_notes', transport: { type: 'stdio', command: 'npx', args: ['-y', 'slack-mcp'], env: { SLACK_TOKEN: '{{secret.SLACK_TOKEN}}' } }, scope: 'global' })
  await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  await page.getByText('L’agent propose d’installer le serveur MCP slack_notes').waitFor({ timeout: 15000 })
  await page.getByRole('radio', { name: /Toute l’instance/, checked: true }).waitFor()
  const declined = page.waitForResponse(response => response.url().includes('/mcp-installs/') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Refuser', exact: true }).click()
  assert.ok((await declined).ok())
  await page.getByText('Refusé', { exact: true }).waitFor()
  assert.equal((await (await context.request.get(`${base}/api/mcp/servers`)).json()).servers.length, before + 1)
  assert.equal((await (await context.request.get(`${base}/api/secrets`)).json()).secrets.some(entry => entry.name === 'SLACK_TOKEN'), false)
  await page.screenshot({ path: join(shots, 'declined.png') })

  assert.deepEqual(errors, [])
  db.close()
  console.log(`mcp-install-ui-check: ok — captures in ${shots}`)
} catch (error) {
  await page?.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {})
  console.error(`Screenshots: ${shots}`)
  throw error
} finally {
  await browser?.close()
  for (const unit of units) { try { execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' }) } catch {} }
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
