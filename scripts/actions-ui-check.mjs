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

// Actions de projet, de bout en bout : vraie API, vrai serveur MCP, vrais terminaux, et
// sous Linux une vraie unité systemd utilisateur (`sillage-app-action-*`), arrêtée et
// retirée à la fin. Les captures vont dans ACTIONS_SHOTS, ou dans un dossier temporaire.
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

/** Un appel d'outil sur le vrai serveur MCP, comme le ferait un CLI. */
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

const linuxServices = process.platform === 'linux' &&
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

  // Une tâche créée depuis l'API, donc validée d'office.
  const created = await context.request.post(`${base}/api/projects/${project.id}/actions`, {
    data: { label: 'Dire bonjour', kind: 'task', command: 'echo hello-from-action; exit 2', description: 'Un essai qui échoue exprès' },
  })
  assert.equal(created.status(), 201)
  const task = await created.json()
  assert.equal(task.status, 'approved')

  // Un service proposé par un agent, par le vrai serveur MCP.
  const registered = await mcp(env, conversation.id, project.id, 'register_action', {
    label: 'Serveur statique',
    kind: 'service',
    command: `python3 -m http.server --bind 127.0.0.1 ${httpPort}`,
    description: 'Sert le dossier du projet',
    url: 'http://127.0.0.1:{port}/',
  })
  assert.ok(!registered.isError, registered.content[0].text)
  const listed = await mcp(env, conversation.id, project.id, 'list_actions', {})
  assert.match(listed.content[0].text, /Serveur statique.*en attente de validation/)
  const service = (await api('/api/actions')).find((action) => action.label === 'Serveur statique')
  assert.equal(service.status, 'proposed')

  // Un clic ne lance pas une action proposée.
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

  // La tâche : le disque la lance, son terminal passe devant avec la sortie et le code.
  await page.getByRole('button', { name: 'Lancer : Dire bonjour' }).first().click()
  await page.locator('.xterm-rows', { hasText: 'hello-from-action' }).waitFor({ timeout: 10000 })
  await page.locator('.xterm-rows', { hasText: '[exit 2]' }).waitFor({ timeout: 10000 })
  assert.equal(await page.getByText('Connexion au terminal impossible.').count(), 0)
  await page.screenshot({ path: join(shots, 'actions-task-terminal.png') })
  await actionsTab.click()
  await panel.getByText(/Sortie en code 2/).waitFor({ timeout: 15000 })

  // Le service proposé : relu (commande en clair), validé, lancé d'un geste.
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
    await page.screenshot({ path: join(shots, 'actions-service-running.png') })

    // Le lanceur de l'en-tête compte le service en marche et montre la même liste.
    const launcher = page.getByRole('button', { name: 'Actions, 1 en marche' })
    await launcher.click()
    const popover = page.getByRole('dialog', { name: 'Actions' })
    await popover.getByRole('button', { name: 'Arrêter : Serveur statique' }).waitFor()
    await page.screenshot({ path: join(shots, 'actions-launcher.png') })
    await page.keyboard.press('Escape')

    // La palette suit l'état : un service en marche s'arrête, il ne se relance pas.
    await page.keyboard.press('Control+k')
    await page.getByRole('option', { name: /Arrêter : Serveur statique/ }).waitFor()
    await page.getByRole('option', { name: /Ouvrir : Serveur statique/ }).waitFor()
    assert.equal(await page.getByRole('option', { name: /Lancer : Serveur statique/ }).count(), 0)
    await page.screenshot({ path: join(shots, 'actions-palette.png') })
    await page.getByRole('option', { name: /Arrêter : Serveur statique/ }).click()
    await panel.getByText('Arrêté').waitFor({ timeout: 20000 })

    // Arrêté, le service se relance depuis la palette, et le journal s'ouvre du menu.
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
    // Sans systemd utilisateur, le service retombe dans un terminal.
    await page.locator('.xterm-rows', { hasText: 'python3 -m http.server' }).waitFor({ timeout: 10000 })
  }

  // Au téléphone.
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
  await mobile.keyboard.press('Escape')
  await mobile.getByRole('button', { name: 'Ouvrir le panneau' }).first().click()
  await mobile.locator('button[aria-pressed][aria-label^="Actions"]').click()
  await mobile.getByText('Dire bonjour').waitFor()
  await mobile.screenshot({ path: join(shots, 'actions-phone.png') })

  // Supprimer le service arrête et retire son unité.
  for (const action of await api('/api/actions')) {
    if (action.projectId !== project.id) continue
    const removed = await context.request.delete(`${base}/api/actions/${action.id}`)
    assert.equal(removed.status(), 204)
  }
  assert.deepEqual(errors, [])
  console.log(`actions-ui-check: ok — captures dans ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
