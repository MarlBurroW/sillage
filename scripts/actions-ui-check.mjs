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

// Project actions end to end: real API, MCP server, terminals, and on Linux a real
// systemd user unit (`sillage-app-action-*`), stopped/removed at completion.
// ACTIONS_NO_SYSTEMD=1 hides the user manager from the server, as on Windows and macOS,
// so services run in terminals. Screenshots go to ACTIONS_SHOTS or a temporary directory.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-actions-check-'))
const shots = process.env.ACTIONS_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-actions-shots-')))
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

/** Tool call on the real MCP server, as a CLI would make it. */
async function mcp(env, conversationId, projectId, name, args) {
  const child = spawn(process.execPath, [join(serverDir, 'src/mcp/sillage-mcp.mjs')], {
    env: {
      ...process.env,
      SILLAGE_MCP_DB: join(env.SILLAGE_DATA_DIR, 'sillage.db'),
      SILLAGE_MCP_PROJECT: projectId,
      SILLAGE_MCP_CONVERSATION: conversationId,
    },
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  for (let i = 0; i < 300 && !stdout.includes('\n'); i++) await delay(100)
  child.kill()
  return JSON.parse(stdout).result
}

const noSystemd = process.env.ACTIONS_NO_SYSTEMD === '1'
const linuxServices = !noSystemd && process.platform === 'linux' &&
  (() => { try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }); return true } catch { return false } })()

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const httpPort = await freePort()
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
  // Without these, `systemctl --user` cannot reach the user manager.
  if (noSystemd) {
    delete env.XDG_RUNTIME_DIR
    delete env.DBUS_SESSION_BUS_ADDRESS
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
  assert.ok(conversation, 'Nimbus a une conversation de démo')

  // API-created task, therefore approved automatically.
  const created = await context.request.post(`${base}/api/projects/${project.id}/actions`, {
    data: { label: 'Dire bonjour', kind: 'task', command: 'echo hello-from-action; exit 2', description: 'Un essai qui échoue exprès' },
  })
  assert.equal(created.status(), 201)
  const task = await created.json()
  assert.equal(task.status, 'approved')
  const quick = await (await context.request.post(`${base}/api/projects/${project.id}/actions`, {
    data: { label: 'Vérifier', kind: 'task', command: 'echo tout-va-bien' },
  })).json()
  assert.equal(quick.status, 'approved')

  // Agent-proposed service through the real MCP server.
  const registered = await mcp(env, conversation.id, project.id, 'register_action', {
    label: 'Serveur statique',
    kind: 'service',
    command: `python3 -m http.server --bind 127.0.0.1 ${httpPort}`,
    description: 'Sert le dossier du projet',
    url: 'http://127.0.0.1:{port}/',
  })
  assert.ok(!registered.isError, registered.content[0].text)
  const listed = await mcp(env, conversation.id, project.id, 'list_actions', {})
  assert.match(listed.content[0].text, /Serveur statique.*awaiting user approval/)
  const service = (await api('/api/actions')).find((action) => action.label === 'Serveur statique')
  assert.equal(service.status, 'proposed')

  // One click does not launch a proposed action.
  const refused = await context.request.post(`${base}/api/actions/${service.id}/run`, { data: {} })
  assert.equal(refused.status(), 409)

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  const actionsTab = page.locator('button[aria-pressed][aria-label^="Actions"]')
  await page.getByRole('button', { name: 'Ouvrir le panneau' }).first().click()
  await actionsTab.click()
  const panel = page.locator('ul', { hasText: 'Dire bonjour' }).first()
  await panel.getByText('À relire').waitFor()
  await page.screenshot({ path: join(shots, 'actions-desktop.png') })

  // Task: launching keeps the Actions tab in place. A notice reports the failure, and its
  // button brings the terminal forward with output and exit code.
  await page.getByRole('button', { name: 'Lancer : Dire bonjour' }).first().click()
  const failure = page.getByRole('status').filter({ hasText: 'Dire bonjour' })
  await failure.getByText('Sortie en code 2').waitFor({ timeout: 15000 })
  await panel.getByText(/Sortie en code 2/).waitFor()
  assert.equal(await page.locator('.xterm-rows').count(), 0, 'launching does not open the terminal')
  await page.screenshot({ path: join(shots, 'actions-task-notice.png') })
  await failure.getByRole('button', { name: 'Voir la sortie' }).click()
  await page.locator('.xterm-rows', { hasText: 'hello-from-action' }).waitFor({ timeout: 10000 })
  await page.locator('.xterm-rows', { hasText: '[exit 2]' }).waitFor({ timeout: 10000 })
  assert.equal(await page.getByText('Connexion au terminal impossible.').count(), 0)
  assert.equal(await failure.count(), 0, 'opening the output dismisses the notice')
  await page.screenshot({ path: join(shots, 'actions-task-terminal.png') })

  // The agent reads the run the user launched.
  const read = await mcp(env, conversation.id, project.id, 'read_action_output', { id: task.id })
  assert.ok(!read.isError, read.content[0].text)
  assert.match(read.content[0].text, /failed \(exit 2\)/)
  assert.match(read.content[0].text, /\nhello-from-action\n/)
  await actionsTab.click()

  // Header launcher: two launches in a row, the popover staying open. Success leaves by itself,
  // failure stays until dismissed.
  await page.locator('button:not([aria-pressed])[aria-label="Actions"]').click()
  const launcherList = page.getByRole('dialog', { name: 'Actions' })
  await launcherList.getByRole('button', { name: 'Lancer : Vérifier' }).click()
  await launcherList.getByRole('button', { name: 'Lancer : Dire bonjour' }).click()
  const success = page.getByRole('status').filter({ hasText: 'Vérifier' })
  await success.getByText('Réussie').waitFor({ timeout: 15000 })
  await failure.getByText('Sortie en code 2').waitFor({ timeout: 15000 })
  assert.ok(await launcherList.isVisible(), 'the launcher stays open while launching')
  await page.screenshot({ path: join(shots, 'actions-launcher-notices.png') })
  await page.keyboard.press('Escape')
  await success.waitFor({ state: 'detached', timeout: 10000 })
  assert.equal(await failure.count(), 1)
  await failure.getByRole('button', { name: 'Fermer' }).click()

  // Proposed service: reviewed (plain command), approved, launched in one action.
  await page.getByRole('button', { name: 'Relire : Serveur statique' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText(`python3 -m http.server --bind 127.0.0.1 ${httpPort}`).waitFor()
  await page.screenshot({ path: join(shots, 'actions-review.png') })
  await dialog.getByRole('button', { name: 'Valider et lancer' }).click()

  if (linuxServices) {
    await panel.getByText(`Écoute sur :${httpPort}`).waitFor({ timeout: 20000 })
    const open = panel.getByRole('link', { name: `127.0.0.1:${httpPort}/` })
    assert.equal(await open.getAttribute('href'), `http://127.0.0.1:${httpPort}/`)
    const served = await fetch(`http://127.0.0.1:${httpPort}/`).then((response) => response.status)
    assert.equal(served, 200)
    // The agent reads the unit's journal, where http.server logs that request.
    let journal = ''
    for (let i = 0; i < 50 && !/GET \/ HTTP/.test(journal); i++) {
      journal = (await mcp(env, conversation.id, project.id, 'read_action_output', { id: service.id })).content[0].text
      await delay(100)
    }
    assert.match(journal, /unit active/)
    assert.match(journal, /GET \/ HTTP/)
    await page.screenshot({ path: join(shots, 'actions-service-running.png') })

    // Header launcher counts running services and shows the same list.
    const launcher = page.getByRole('button', { name: 'Actions, 1 en marche' })
    await launcher.click()
    const popover = page.getByRole('dialog', { name: 'Actions' })
    await popover.getByRole('button', { name: 'Arrêter : Serveur statique' }).waitFor()
    await page.screenshot({ path: join(shots, 'actions-launcher.png') })
    await page.keyboard.press('Escape')

    // Palette follows state: running services stop rather than relaunch.
    await page.keyboard.press('Control+k')
    await page.getByRole('option', { name: /Arrêter : Serveur statique/ }).waitFor()
    await page.getByRole('option', { name: /Ouvrir : Serveur statique/ }).waitFor()
    assert.equal(await page.getByRole('option', { name: /Lancer : Serveur statique/ }).count(), 0)
    await page.screenshot({ path: join(shots, 'actions-palette.png') })
    await page.getByRole('option', { name: /Arrêter : Serveur statique/ }).click()
    await panel.getByText('Arrêté').waitFor({ timeout: 20000 })

    // Stopped services restart from palette; logs open from menu.
    await page.keyboard.press('Control+k')
    await page.getByRole('combobox').fill('Lancer serveur')
    await page.getByRole('option', { name: /Lancer : Serveur statique/ }).click()
    await panel.getByText(`Écoute sur :${httpPort}`).waitFor({ timeout: 20000 })
    await panel.locator('li', { hasText: 'Serveur statique' }).getByRole('button', { name: 'Plus' }).click()
    await page.getByRole('menuitem', { name: 'Suivre le journal' }).click()
    await page.getByText('Serveur statique · logs').waitFor()
    await actionsTab.click()
    await page.getByRole('button', { name: 'Arrêter : Serveur statique' }).first().click()
    await panel.getByText('Arrêté').waitFor({ timeout: 20000 })
  } else {
    // Without user systemd (Windows, macOS), the service runs in a terminal: launching opens
    // nothing, the row offers Stop, and the agent reads it like a task.
    const row = panel.locator('li', { hasText: 'Serveur statique' })
    await row.getByRole('button', { name: 'Arrêter : Serveur statique' }).waitFor({ timeout: 20000 })
    await row.getByText('En marche').waitFor()
    let output = ''
    for (let i = 0; i < 50 && !/still running/.test(output); i++) {
      output = (await mcp(env, conversation.id, project.id, 'read_action_output', { id: service.id })).content[0].text
      await delay(100)
    }
    assert.match(output, /“Serveur statique” \(service\): still running/)
    assert.match(output, /python3 -m http\.server/)
    await page.screenshot({ path: join(shots, 'actions-service-terminal.png') })
    await row.getByRole('button', { name: 'Arrêter : Serveur statique' }).click()
    await row.getByRole('button', { name: 'Lancer : Serveur statique' }).waitFor({ timeout: 20000 })
    await delay(3000)
    assert.equal(await page.getByRole('status').filter({ hasText: 'Serveur statique' }).count(), 0, 'a requested stop is not reported')
  }

  // An agent's proposal shows beneath its call in the thread, reviewed and launched there.
  const lint = await mcp(env, conversation.id, project.id, 'register_action', { label: 'Lint', kind: 'task', command: 'echo lint-ok' })
  assert.ok(!lint.isError, lint.content[0].text)
  const { default: Database } = await import(join(serverDir, 'node_modules/better-sqlite3/lib/index.js'))
  const db = new Database(join(env.SILLAGE_DATA_DIR, 'sillage.db'))
  const owner = db.prepare('SELECT owner_id AS id FROM projects WHERE id = ?').get(project.id).id
  const now = Date.now()
  const threadEvents = [
    { type: 'message.completed', messageId: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Corrige les avertissements du linter.' }], parentToolCallId: null },
    { type: 'tool.started', toolCallId: 'call-1', name: 'mcp__sillage__register_action', input: { label: 'Lint', kind: 'task', command: 'echo lint-ok' }, parentToolCallId: null },
    { type: 'tool.completed', toolCallId: 'call-1', output: [{ type: 'text', text: lint.content[0].text }], isError: false, durationMs: 300 },
    { type: 'message.completed', messageId: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'C’est corrigé. Je t’ai proposé un bouton « Lint » pour relancer le linter.' }], parentToolCallId: null },
  ]
  db.prepare(`INSERT INTO conversations (id, project_id, user_id, title, agent, config, status, last_seq, last_notable_seq, position, created_at, updated_at)
              VALUES ('agent-thread', ?, ?, 'Avertissements du linter', 'claude', ?, 'idle', ?, ?, -100, ?, ?)`)
    .run(project.id, owner, JSON.stringify({ agent: 'claude', model: 'default', effort: 'medium', permissionMode: 'bypassPermissions' }), threadEvents.length, threadEvents.length, now, now)
  const insertEvent = db.prepare('INSERT INTO events (conversation_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
  threadEvents.forEach((event, index) => insertEvent.run('agent-thread', index + 1, now + index, event.type, JSON.stringify(event)))
  db.close()
  await page.goto(`${base}/p/${project.id}/c/agent-thread`)
  const proposal = page.locator('[data-action-proposal]')
  await proposal.getByText('Action « Lint » proposée').waitFor()
  await page.screenshot({ path: join(shots, 'actions-proposal-inline.png') })
  await proposal.getByRole('button', { name: 'Relire', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Valider et lancer' }).click()
  await page.getByRole('status').filter({ hasText: 'Lint' }).getByText('Réussie').waitFor({ timeout: 15000 })
  await proposal.getByText('Action « Lint » dans le menu Actions').waitFor()
  await page.screenshot({ path: join(shots, 'actions-proposal-approved.png') })

  // On a phone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await phone.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  await phone.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const mobile = await phone.newPage()
  mobile.on('pageerror', (error) => errors.push(error.message))
  await mobile.goto(`${base}/p/${project.id}/c/${conversation.id}`)
  await mobile.getByRole('button', { name: 'Actions', exact: true }).click()
  await mobile.getByRole('dialog', { name: 'Actions' }).getByText('Dire bonjour').waitFor()
  await mobile.screenshot({ path: join(shots, 'actions-phone-launcher.png') })
  await mobile.getByRole('dialog', { name: 'Actions' }).getByRole('button', { name: 'Lancer : Vérifier' }).click()
  await mobile.getByRole('status').filter({ hasText: 'Vérifier' }).getByText('Réussie').waitFor({ timeout: 15000 })
  await mobile.screenshot({ path: join(shots, 'actions-phone-notice.png') })
  await mobile.keyboard.press('Escape')
  await mobile.getByRole('button', { name: 'Ouvrir le panneau' }).first().click()
  await mobile.locator('button[aria-pressed][aria-label^="Actions"]').click()
  await mobile.getByText('Dire bonjour').waitFor()
  await mobile.screenshot({ path: join(shots, 'actions-phone.png') })

  // Deleting service stops and removes its unit.
  for (const action of await api('/api/actions')) {
    if (action.projectId !== project.id) continue
    const removed = await context.request.delete(`${base}/api/actions/${action.id}`)
    assert.equal(removed.status(), 204)
  }
  assert.deepEqual(errors, [])
  console.log(`actions-ui-check: ok — captures dans ${shots}`)
} catch (error) {
  // The page as it was when a step failed: most failures read at a glance there.
  for (const [index, open] of (browser?.contexts() ?? []).flatMap((context) => context.pages()).entries()) {
    await open.screenshot({ path: join(shots, `failure-${index}.png`) }).catch(() => undefined)
  }
  console.error(`actions-ui-check: captures in ${shots}`)
  throw error
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
