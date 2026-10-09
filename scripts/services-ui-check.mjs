import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

// Base, projets et serveurs jetables : aucun agent ni service utilisateur n'est arrêté.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const runtime = process.env.SILLAGE_TEST_RUNTIME
const data = await mkdtemp(join(tmpdir(), 'sillage-services-ui-'))
const children = []
const trackedProcesses = []
// Unités systemd jetables, arrêtées en sortie même si le contrôle échoue.
const units = []
const systemd = (args) => promisify(execFile)('systemd-run', ['--user', '--collect', ...args])
let browser

async function port() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const number = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return number
}

function run(args, cwd, env, binary = process.execPath) {
  const child = spawn(binary, args, { cwd, env, stdio: 'pipe' })
  children.push(child)
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
  throw new Error(`Service did not start: ${child.diagnostics}`)
}

try {
  const [apiPort, webPort, servicePort, oldPort, appPort] = await Promise.all([port(), port(), port(), port(), port()])
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = { ...process.env, SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: runtime ? join(runtime, 'web') : join(data, 'web') }
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)
  const Sqlite = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
  const db = new Sqlite(join(env.SILLAGE_DATA_DIR, 'sillage.db'), { readonly: true })
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get('Nimbus')
  const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? LIMIT 1').get(project.id)
  db.close()
  const token = randomUUID()
  await mkdir(join(env.SILLAGE_DATA_DIR, 'process-origins'))
  await writeFile(join(env.SILLAGE_DATA_DIR, 'process-origins', `${token}.json`), JSON.stringify({ projectId: project.id, conversationId: conversation.id }))
  const script = (number) => `require('node:http').createServer((_, res) => res.end('fixture')).listen(${number}, '127.0.0.1')`
  // Même dossier et même marqueur que l’agent : ce frère indépendant doit être exclu.
  const old = run(['-e', script(oldPort)], project.workspace_path, { PATH: process.env.PATH, SILLAGE_PROCESS_ORIGIN: token })
  const server = runtime
    ? run(['server/main.js'], runtime, env, process.env.SILLAGE_TEST_NODE)
    : run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = runtime ? server : run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${runtime ? apiPort : webPort}`
  await Promise.all([ready(`${base}/api/health`, server), ready(base, vite), ready(`http://127.0.0.1:${oldPort}`, old)])
  // Une app permanente comme un agent la crée : unité sillage-app-*, avec le jeton d’origine.
  const appName = `uicheck-${token.slice(0, 8)}`
  units.push(`sillage-app-${appName}.service`)
  await systemd([`--unit=sillage-app-${appName}`, `--setenv=SILLAGE_PROCESS_ORIGIN=${token}`, `--working-directory=${project.workspace_path}`, process.execPath, '-e', script(appPort)])
  await ready(`http://127.0.0.1:${appPort}`, server)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const terminalResponse = await context.request.post(`${base}/api/projects/${project.id}/terminals`, { data: {} })
  assert.equal(terminalResponse.status(), 201)
  const terminal = await terminalResponse.json()
  const serviceFile = join(project.workspace_path, 'service-fixture.cjs')
  const workerFile = join(project.workspace_path, 'worker-fixture.cjs')
  const servicePidFile = join(data, 'service.pid')
  const workerPidFile = join(data, 'worker.pid')
  await writeFile(serviceFile, `require('node:fs').writeFileSync(${JSON.stringify(servicePidFile)}, String(process.pid)); ${script(servicePort)}`)
  await writeFile(workerFile, `require('node:fs').writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
  const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
  const command = `SILLAGE_PROCESS_ORIGIN=${quote(token)} ${quote(process.execPath)} ${quote(serviceFile)} &\r${quote(process.execPath)} ${quote(workerFile)} &\r`
  const terminalPage = await context.newPage()
  await terminalPage.goto(base)
  await terminalPage.evaluate(async ({ projectId, terminalId, command }) => {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/api/projects/${projectId}/terminal?terminalId=${terminalId}`)
      socket.onerror = () => reject(new Error('Terminal socket failed'))
      socket.onmessage = (event) => {
        if (JSON.parse(event.data).t === 'ready') {
          socket.send(JSON.stringify({ t: 'input', data: command }))
          setTimeout(() => { socket.close(); resolve() }, 100)
        }
      }
    })
  }, { projectId: project.id, terminalId: terminal.id, command })
  await terminalPage.close()
  async function waitPid(file) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const pid = Number(await readFile(file, 'utf8').catch(() => ''))
      if (pid) {
        const identity = await readFile(`/proc/${pid}/stat`, 'utf8')
        trackedProcesses.push({ pid, start: identity.slice(identity.lastIndexOf(')') + 2).split(' ')[19] })
        return pid
      }
      await delay(100)
    }
    throw new Error(`Missing PID file: ${file}`)
  }
  const service = { pid: await waitPid(servicePidFile) }
  const worker = { pid: await waitPid(workerPidFile) }
  await ready(`http://127.0.0.1:${servicePort}`, server)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/services`)
  await page.getByRole('heading', { name: 'Services', exact: true }).waitFor()
  const appCard = page.locator('li').filter({ hasText: appName })
  await appCard.getByText(`:${appPort}`, { exact: true }).waitFor()
  await appCard.getByText('En marche', { exact: true }).waitFor()
  await appCard.getByRole('link', { name: conversation.title, exact: true }).waitFor()
  await appCard.getByText(`Journal : journalctl --user -u sillage-app-${appName}.service`, { exact: true }).waitFor()
  const row = page.locator('li').filter({ hasText: `PID ${service.pid}` })
  const oldRow = page.locator('li').filter({ hasText: `PID ${old.pid}` })
  await row.getByText(`:${servicePort}`, { exact: true }).waitFor()
  await row.getByRole('link', { name: conversation.title, exact: true }).waitFor()
  assert.equal(await oldRow.count(), 0, 'Un service indépendant est exclu même avec le même dossier et le même marqueur')
  const workerRow = page.locator('li').filter({ hasText: `PID ${worker.pid}` })
  // Les deux commandes sont rangées sous le terminal qui les a lancées, avec leur ligne de commande.
  const terminalGroup = page.locator('section').filter({ has: page.getByText('Terminal', { exact: true }) })
  await terminalGroup.getByRole('link', { name: 'Nimbus', exact: true }).first().waitFor()
  assert.equal(await terminalGroup.locator('li').filter({ hasText: `PID ${worker.pid}` }).count(), 1)
  await row.locator('code').filter({ hasText: 'service-fixture.cjs' }).waitFor()
  await workerRow.locator('code').filter({ hasText: 'worker-fixture.cjs' }).waitFor()
  await appCard.locator('code').filter({ hasText: /^node -e / }).waitFor()
  await page.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Nimbus', exact: true }).click()
  assert.equal(await oldRow.count(), 0)
  await appCard.getByText(`:${appPort}`, { exact: true }).waitFor()
  await page.screenshot({ path: '/tmp/sillage-services-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  // Le tiroir de navigation termine sa transition après le changement de breakpoint.
  await delay(350)
  await page.locator('[data-navigation-trigger]').click()
  await page.getByRole('link', { name: 'Services', exact: true }).click()
  await delay(350)
  await row.getByRole('button', { name: 'Arrêter', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/sillage-services-mobile.png', fullPage: true })
  await appCard.getByRole('button', { name: 'Arrêter', exact: true }).click()
  await appCard.waitFor({ state: 'detached', timeout: 12000 })
  assert.equal(await fetch(`http://127.0.0.1:${appPort}`).then(() => true, () => false), false, 'L’app arrêtée ne répond plus')
  await row.getByRole('button', { name: 'Arrêter', exact: true }).click()
  await row.waitFor({ state: 'detached', timeout: 12000 })
  await workerRow.getByRole('button', { name: 'Arrêter', exact: true }).click()
  await workerRow.waitFor({ state: 'detached', timeout: 12000 })
  await terminalGroup.getByText('Aucune commande en cours', { exact: true }).waitFor()
  assert.equal(old.exitCode, null, 'Stopping one service must not stop another')
  assert.deepEqual(errors, [])
  console.log('OK : commandes rangées sous leur terminal, lignes de commande, processus sans port, exclusion des services indépendants, app permanente, mobile et arrêt ciblé.')
} finally {
  await browser?.close()
  for (const unit of units) {
    await promisify(execFile)('systemctl', ['--user', 'stop', unit]).catch(() => {})
    await promisify(execFile)('systemctl', ['--user', 'reset-failed', unit]).catch(() => {})
  }
  for (const { pid, start } of trackedProcesses) {
    const current = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
    if (current && current.slice(current.lastIndexOf(')') + 2).split(' ')[19] === start) process.kill(pid, 'SIGTERM')
  }
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  }
  await rm(data, { recursive: true, force: true })
}
