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
 * L'application de bureau empaquetée, lancée pour de vrai : son serveur démarre, la
 * fenêtre s'ouvre sans page de connexion, les écrans réservés au serveur hébergé ont
 * disparu, le serveur refuse ce qui ne vient pas de la fenêtre, et quitter l'arrête.
 *
 * Il ouvre aussi un terminal, qui doit exécuter une commande dans le shell de la plateforme
 * (PowerShell sous Windows), et joue un script de vérification de tâche planifiée, qui doit
 * passer par le shell POSIX (le bash de Git for Windows). Avec SILLAGE_CHECK_INSTALL=<cli>
 * (ou une liste séparée par des virgules), il installe ces CLI par le npm que l'app
 * embarque, puis vérifie qu'ils sont détectés et répondent à --version.
 *
 * Le profil de l'app (base, réglages, journal) va dans un dossier temporaire, par
 * SILLAGE_DESKTOP_USER_DATA. Sous Linux, il faut un écran (xvfb-run) et, là où les
 * namespaces sont restreints (Ubuntu 24.04+), un profil AppArmor pour l'exécutable testé.
 *
 * Usage : node scripts/desktop-ui-check.mjs [exécutable]
 * (par défaut celui que produit electron-builder pour la plateforme courante)
 */
const root = fileURLToPath(new URL('../', import.meta.url))
const executable = process.argv[2] ?? join(root, 'apps/desktop/release', packagedApp())
const scratch = await mkdtemp(join(tmpdir(), 'sillage-desktop-check-'))
const userData = join(scratch, 'user-data')
const shots = join(scratch, 'shots')
await mkdir(shots)
let app

/**
 * L'app non emballée, là où electron-builder la laisse : son dossier ne porte pas
 * l'architecture pour x64 (`linux-unpacked`, `mac`), mais la porte pour les autres
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
 * Ce qu'un CLI muet répond quand on le lance à la main, sans le délai de la sonde : son
 * lanceur npm, puis sa sortie, à lire dans le journal de la CI.
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

/** Une requête HTTP brute, pour forger `Host` et `Origin` comme le ferait une page hostile. */
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
    env: { ...process.env, SILLAGE_DESKTOP_USER_DATA: userData },
    timeout: 120_000,
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForLoadState('domcontentloaded')
  // Premier lancement : le compte local ouvert par le lanceur a sa visite armée, et la
  // fenêtre s'ouvre dessus, sans étape de compte ni de mot de passe. On la passe ; « C'est
  // prêt » mène à la création du premier projet, dans la coque de l'application.
  await page.waitForURL(/\/bienvenue$/, { timeout: 60_000 })
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  assert.equal(await page.getByText(/Créer ton compte|Create your account/).count(), 0, 'pas de compte à créer en bureau')
  await page.screenshot({ path: join(shots, 'onboarding.png') })
  await page.getByRole('button', { name: /Passer la visite|Skip the tour/ }).click()
  await page.getByRole('heading', { level: 1, name: /C’est prêt\.|All set\./ }).waitFor()
  await page.getByRole('button', { name: /Créer mon premier projet|Create my first project/ }).click()
  await page.waitForURL(/\/projects\/new$/)
  // La coque de l'application, signe que la session est ouverte.
  await page.getByRole('link', { name: /Paramètres|Settings/ }).first().waitFor({ timeout: 60_000 })
  // Un seul compte en bureau : la création d'un projet ne demande pas s'il est partagé.
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

  // Seule la fenêtre parle au serveur : une autre origine, un autre `Host` (DNS
  // rebinding), une WebSocket ouverte depuis une autre page locale, tout est refusé.
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

  // Un terminal tourne dans le shell interactif de la plateforme, par le pty du serveur.
  // L'expression n'apparaît calculée que dans la sortie, jamais dans l'écho de la saisie.
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

  // Un script de vérification passe par le shell POSIX, le bash de Git for Windows sous
  // Windows : l'expression arithmétique n'y donne 42 que dans un shell POSIX.
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

  // Un CLI s'installe par le npm embarqué, et se lance ensuite par son lanceur npm : sous
  // Windows, un `.cmd` que le serveur doit savoir lire. Un à un : deux installations dans le
  // même préfixe npm se marcheraient dessus.
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

  // La session a transité par le tube du lanceur, jamais par le journal.
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
