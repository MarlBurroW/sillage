import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

/**
 * Launch the packaged desktop app for real: server starts, window opens without
 * sign-in, hosted-server-only screens disappear, requests from outside the window
 * are refused, quitting stops the server.
 *
 * Also opens a terminal that must execute in the platform shell (PowerShell on
 * Windows), and runs a scheduled-task check script through POSIX shell (Git for
 * Windows bash). With SILLAGE_CHECK_INSTALL=<cli> (or comma-separated list), installs
 * CLIs through bundled npm, then checks detection and --version.
 *
 * App profile (database, settings, log) uses a temporary directory through
 * SILLAGE_DESKTOP_USER_DATA. Linux needs a display (xvfb-run) and, where namespaces
 * are restricted (Ubuntu 24.04+), an AppArmor profile for the tested executable.
 *
 * Usage: node scripts/desktop-ui-check.mjs [executable]
 * (defaults to electron-builder output for the current platform)
 */
const root = fileURLToPath(new URL('../', import.meta.url))
const executable = process.argv[2] ?? join(root, 'apps/desktop/release', packagedApp())
const scratch = await mkdtemp(join(tmpdir(), 'sillage-desktop-check-'))
const userData = join(scratch, 'user-data')
const shots = join(scratch, 'shots')
await mkdir(shots)
let app

/**
 * Unpacked app where electron-builder leaves it: directory omits architecture for
 * x64 (`linux-unpacked`, `mac`) but includes it otherwise
 * (`linux-arm64-unpacked`, `mac-arm64`).
 */
function packagedApp() {
  if (process.platform === 'darwin') {
    return `${process.arch === 'x64' ? 'mac' : `mac-${process.arch}`}/Sillage.app/Contents/MacOS/Sillage`
  }
  if (process.platform === 'win32') {
    return `${process.arch === 'x64' ? 'win-unpacked' : `win-${process.arch}-unpacked`}/Sillage.exe`
  }
  return `${process.arch === 'x64' ? 'linux-unpacked' : `linux-${process.arch}-unpacked`}/sillage`
}

/**
 * What a silent CLI returns when run manually without probe timeout: its npm
 * launcher, then output, for reading in CI logs.
 */
function diagnose(path) {
  if (/\.cmd$/i.test(path)) console.log(`lanceur ${path} :\n${readFileSync(path, 'utf8')}`)
  const started = Date.now()
  const result = spawnSync(path, ['--version'], { shell: true, encoding: 'utf8', timeout: 120_000 })
  console.log(
    `${path} --version, ${Date.now() - started} ms : status=${result.status} error=${result.error?.message}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
}

/** Raw HTTP request forging `Host`/`Origin` like a hostile page. */
function raw(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

async function listening(port) {
  return raw(port, '/api/health', { host: `127.0.0.1:${port}` }).then(
    () => true,
    () => false,
  )
}

try {
  app = await electron.launch({
    executablePath: executable,
    chromiumSandbox: true,
    env: { ...process.env, SILLAGE_DESKTOP_USER_DATA: userData },
    timeout: 120_000,
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForLoadState('domcontentloaded')
  // First launch: launcher-created local account has its tour armed, and window
  // opens there without account/password steps. Skip it; “Ready” leads to first-project
  // creation inside the application shell.
  await page.waitForURL(/\/bienvenue$/, { timeout: 60_000 })
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  assert.equal(await page.getByText(/Créer ton compte|Create your account/).count(), 0, 'pas de compte à créer en bureau')
  await page.screenshot({ path: join(shots, 'onboarding.png') })
  await page.getByRole('button', { name: /Passer la visite|Skip the tour/ }).click()
  await page.getByRole('heading', { level: 1, name: /C’est prêt\.|All set\./ }).waitFor()
  await page.getByRole('button', { name: /Créer mon premier projet|Create my first project/ }).click()
  await page.waitForURL(/\/projects\/new$/)
  // Application shell indicates the session is open.
  await page.getByRole('link', { name: /Paramètres|Settings/ }).first().waitFor({ timeout: 60_000 })
  // Desktop has one account: project creation does not ask whether it is shared.
  await page.getByLabel(/^(Nom|Name)$/).first().waitFor()
  assert.equal(await page.getByText(/^(Visibilité|Visibility)$/).count(), 0, 'pas de choix privé/partagé en bureau')

  const url = new URL(page.url())
  assert.equal(url.hostname, '127.0.0.1', `fenêtre sur ${page.url()}`)
  assert.notEqual(url.pathname, '/login', 'la fenêtre ne doit jamais montrer la connexion')
  const port = Number(url.port)

  const instance = await page.evaluate(() => fetch('/api/system/instance').then((response) => response.json()))
  assert.equal(instance.profile, 'desktop')
  assert.deepEqual(instance.capabilities, { passwordAuth: false, webPush: false, pwa: false, sharedProjects: false })
  const version = await page.evaluate(() => fetch('/api/system/version').then((response) => response.json()))
  assert.equal(version.channel, 'desktop')

  assert.equal(await page.getByText(/Se déconnecter|Log out/).count(), 0, 'pas de déconnexion sans mot de passe')
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((list) => list.length)),
    0,
    'aucun service worker en bureau',
  )
  await page.screenshot({ path: join(shots, 'home.png') })

  await page.goto(new URL('/settings', url).href)
  await page.getByRole('link', { name: /Apparence|Appearance/ }).first().waitFor()
  for (const hidden of [/^(Compte|Account)$/, /^Notifications$/, /^(Comptes|Accounts)$/]) {
    assert.equal(await page.getByRole('link', { name: hidden }).count(), 0, `catégorie ${hidden} masquée`)
  }
  await page.screenshot({ path: join(shots, 'settings.png') })

  // Only the window talks to the server: another origin, another `Host` (DNS
  // rebinding), or a WebSocket from another local page are all rejected.
  const host = `127.0.0.1:${port}`
  assert.equal(await raw(port, '/api/health', { host }), 200)
  assert.equal(await raw(port, '/api/health', { host: `attacker.example:${port}` }), 403)
  assert.equal(await raw(port, '/api/auth/me', { host, origin: 'http://127.0.0.1:5173' }), 403)
  assert.equal(
    await raw(port, '/api/ws', {
      host,
      origin: 'http://localhost:3000',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    }),
    403,
  )

  // Terminal runs the interactive platform shell through server pty. The expression
  // is evaluated only in output, never echoed input.
  const workspace = join(scratch, 'workspace')
  await mkdir(workspace)
  const project = await page.evaluate(async (workspacePath) => {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Essai', workspacePath }),
    })
    return response.json()
  }, workspace)
  assert.ok(project.id, `projet non créé : ${JSON.stringify(project)}`)
  const input = process.platform === 'win32' ? 'Write-Output ("sillage-" + (40 + 2))\r' : 'echo sillage-$((40 + 2))\r'
  const terminal = await page.evaluate(
    async ({ projectId, input }) => {
      const opened = await fetch(`/api/projects/${projectId}/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).then((response) => response.json())
      return await new Promise((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/api/projects/${projectId}/terminal?terminalId=${opened.id}`)
        let output = ''
        const done = (ok) => {
          clearTimeout(timer)
          socket.close()
          resolve({ ok, output: output.slice(-800) })
        }
        const timer = setTimeout(() => done(false), 30_000)
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.t === 'ready') socket.send(JSON.stringify({ t: 'input', data: input }))
          if (message.t === 'output') output += message.data
          if (output.includes('sillage-42')) done(true)
        }
        socket.onerror = () => done(false)
      })
    },
    { projectId: project.id, input },
  )
  assert.ok(terminal.ok, `le terminal n'a pas exécuté la commande : ${JSON.stringify(terminal.output)}`)

  // Check scripts use POSIX shell, Git for Windows bash on Windows: the arithmetic
  // expression yields 42 only in a POSIX shell.
  const check = await page.evaluate(
    (projectId) =>
      fetch(`/api/projects/${projectId}/schedules/check-test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'echo "sillage-$((40 + 2)) $(uname -s)"', timeoutSeconds: 30 }),
      }).then((response) => response.json()),
    project.id,
  )
  assert.match(check.stdout ?? '', /sillage-42/, `script de vérification : ${JSON.stringify(check)}`)
  console.log(`script de vérification : ${check.stdout.trim()}`)

  // CLI installs through bundled npm then runs through its npm launcher: on Windows,
  // a `.cmd` the server must read. Sequentially: two installs in one npm prefix
  // would interfere.
  for (const cli of (process.env.SILLAGE_CHECK_INSTALL ?? '').split(',').map((name) => name.trim()).filter(Boolean)) {
    const started = await page.evaluate((name) => fetch(`/api/agents/${name}/install`, { method: 'POST' }).then((r) => r.status), cli)
    assert.equal(started, 202)
    let agent
    for (let i = 0; i < 120; i++) {
      await delay(5000)
      const list = await page.evaluate(() => fetch('/api/agents?refresh=1').then((r) => r.json()))
      agent = list.agents.find((entry) => entry.agent === cli)
      if (agent.install.status !== 'running') break
    }
    assert.equal(agent.install.status, 'idle', `installation de ${cli} : ${JSON.stringify(agent.install)}`)
    assert.ok(agent.installed && agent.managed, `${cli} non détecté : ${JSON.stringify(agent)}`)
    if (!agent.version) diagnose(agent.path)
    assert.ok(agent.version, `${cli} ne répond pas à --version : ${JSON.stringify(agent)}`)
    console.log(`${cli} ${agent.version} installé : ${agent.path}`)
  }

  // Session traveled through launcher pipe, never logs.
  const log = await readFile(join(userData, 'logs/server.log'), 'utf8')
  const cookie = (await page.context().cookies()).find((entry) => entry.name === 'sillage_session')
  assert.ok(cookie, 'cookie de session posé par le lanceur')
  assert.ok(!log.includes(cookie.value), 'la session ne doit pas apparaître dans le journal')

  await app.close()
  app = undefined
  for (let i = 0; i < 50 && (await listening(port)); i++) await delay(200)
  assert.equal(await listening(port), false, 'quitter l’app arrête son serveur')

  console.log(`desktop-ui-check : ok (captures dans ${shots})`)
} finally {
  await app?.close().catch(() => {})
  if (process.env.KEEP_DESKTOP_CHECK !== '1') await rm(scratch, { recursive: true, force: true })
}
