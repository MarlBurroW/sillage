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

// Automatisations par webhook, de bout en bout dans l'interface : création depuis un
// modèle GitHub, appels signés reçus, explorateur, conditions évaluées en direct,
// script, enregistrement. Aucune session ne part : l'appel qui passerait les conditions
// arrive pendant la pause, et c'est l'essai du serveur qui dit qu'il lancerait.
// Les captures vont dans AUTOMATIONS_SHOTS, ou dans un dossier temporaire.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-automations-check-'))
const shots = process.env.AUTOMATIONS_SHOTS ?? (await mkdtemp(join(tmpdir(), 'sillage-automations-shots-')))
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

try {
  const apiPort = await freePort()
  const webPort = await freePort()
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
  const api = `http://127.0.0.1:${apiPort}`
  await Promise.all([ready(`${api}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  assert.ok(login.ok())
  const project = (await (await context.request.get(`${base}/api/projects`)).json()).find((entry) => entry.name === 'Nimbus')

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // Création depuis le modèle GitHub « issue étiquetée ».
  await page.goto(`${base}/p/${project.id}/schedules`)
  await page.getByRole('button', { name: 'Nouvelle automatisation' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Par un webhook/ }).click()
  // Le formulaire crée, la page configure : modèle et nom, rien d'autre.
  assert.equal(await dialog.getByLabel('Nom').inputValue(), 'Issues étiquetées sillage')
  assert.equal(await dialog.locator('textarea').count(), 0)
  await dialog.getByText('Ensuite, sur la page de l’automatisation', { exact: false }).waitFor()
  await dialog.getByLabel('Nom').fill('Issues étiquetées')
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, 'automations-create.png') })
  await dialog.getByRole('button', { name: 'Créer et configurer' }).click()
  await page.waitForURL(/\/schedules\/[0-9a-f-]{36}$/)
  const taskId = page.url().split('/').pop()
  await page.getByRole('region', { name: 'Banc d’essai' }).waitFor()
  // Les quatre étapes, dans l'ordre où l'on configure, et le prompt du modèle en place.
  for (const step of ['Brancher', 'Déclencher', 'Lancer', 'Garde-fous']) {
    await page.getByRole('region', { name: step }).waitFor()
  }
  assert.match(await page.getByLabel('Prompt', { exact: true }).inputValue(), /Traite l'issue #\{\{payload\.issue\.number\}\}/)

  // L'adresse et le secret, comme on les recopierait dans GitHub.
  const url = await page.locator('code').first().textContent()
  assert.match(url, /\/api\/hooks\/[\w-]{20,}$/)
  await page.getByRole('button', { name: 'Afficher le secret' }).click()
  await page.locator('code', { hasText: /^[0-9a-f]{64}$/ }).waitFor()

  // Le banc d'essai : sans appel reçu, il part de l'exemple du modèle, et dit tout de
  // suite ce que l'automatisation en ferait, prompt rendu compris.
  const bench = page.getByRole('region', { name: 'Banc d’essai' })
  await bench.getByText('Cet appel lancerait une session, sujet « 42 ».').waitFor({ timeout: 15000 })
  assert.equal(await page.locator('[aria-label="Non remplie"]').count(), 0)
  assert.match(await bench.locator('pre').first().textContent(), /Traite l'issue #42 « Crash on startup when the cache is empty »/)
  await bench.getByRole('switch', { name: 'Message complet' }).click()
  assert.match(await bench.locator('pre').first().textContent(), /\[Automatisation Sillage « Issues étiquetées »/)
  await bench.getByRole('switch', { name: 'Message complet' }).click()
  await page.screenshot({ path: join(shots, 'automations-launch.png') })

  // Une variante d'exemple : un autre label, et la condition qui échoue le dit, à droite
  // comme à gauche.
  const pick = async (name) => {
    await bench.getByRole('combobox', { name: 'Appel testé' }).click()
    await page.getByRole('option', { name }).click()
  }
  await pick('Exemple : GitHub : issue étiquetée « bug »')
  await bench.getByText('Cet appel serait ignoré. Condition 3 non remplie : `payload.label.name` vaut « bug ».').waitFor({ timeout: 15000 })
  assert.ok(await page.locator('[aria-label="Non remplie"]').count() >= 1)

  // L'appel se retouche sur place : le corps défile dans son éditeur, et le verdict suit
  // ce qu'on tape.
  await pick('Exemple : GitHub : issue étiquetée « sillage »')
  await bench.getByRole('tab', { name: 'Appel' }).click()
  await bench.getByRole('tab', { name: 'Modifier' }).click()
  const scroller = bench.locator('.cm-scroller')
  assert.ok(await scroller.evaluate((node) => node.scrollHeight > node.clientHeight), 'le corps doit dépasser et défiler')
  await scroller.evaluate((node) => { node.scrollTop = 200 })
  assert.ok(await scroller.evaluate((node) => node.scrollTop > 0), "l'éditeur doit défiler")
  await bench.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('{"action":"labeled","label":{"name":"sillage"},"issue":{"number":7,"title":"Typed by hand"},"sender":{"login":"alex"}}')
  await bench.getByText('Cet appel lancerait une session, sujet « 7 ».').waitFor({ timeout: 15000 })
  await bench.getByText('Modifié à la main.').waitFor()
  await page.screenshot({ path: join(shots, 'automations-test-call.png') })
  await bench.getByRole('tab', { name: 'Prompt' }).click()
  assert.match(await bench.locator('pre').first().textContent(), /Traite l'issue #7 « Typed by hand »/)

  // « Copier en curl » : la commande signée par le serveur, exécutée pour de vrai. Un
  // ping passe la signature et se fait filtrer : rien ne part, mais tout le chemin HTTP
  // a été parcouru, et l'appel arrive au journal.
  await pick(/Exemple : GitHub : ping/)
  await bench.getByRole('tab', { name: 'Appel' }).click()
  await bench.getByRole('button', { name: 'Copier en curl' }).click()
  const command = await bench.locator('pre', { hasText: 'curl' }).textContent()
  assert.match(command, /x-hub-signature-256: sha256=[0-9a-f]{64}/)
  const output = execFileSync('bash', ['-c', command], { encoding: 'utf8' })
  assert.equal(JSON.parse(output).verdict, 'filtered', output)
  await bench.getByRole('tab', { name: /Journal/ }).click()
  await bench.getByText('Condition 1 non remplie : `headers.x-github-event` vaut « ping ».').waitFor({ timeout: 15000 })
  await page.screenshot({ path: join(shots, 'automations-journal.png') })
  // Un appel reçu s'essaie d'un clic : il se pose sur le banc.
  await bench.getByRole('button', { name: 'Essayer' }).first().click()
  await bench.getByRole('combobox', { name: 'Appel testé' }).filter({ hasText: /Reçu .* : ping/ }).waitFor()
  await bench.getByText(/Cet appel serait ignoré\. Condition 1/).waitFor({ timeout: 15000 })

  // Revenir à l'exemple qui passe, pour la suite.
  await pick('Exemple : GitHub : issue étiquetée « sillage »')
  await bench.getByText('Cet appel lancerait une session', { exact: false }).waitFor()

  // L'explorateur : filtrer sur un champ, l'insérer dans le prompt.
  await bench.getByRole('tab', { name: 'Appel' }).click()
  await bench.getByRole('tab', { name: 'Explorer' }).click()
  await bench.getByRole('button', { name: 'Insérer {{payload.repository}} dans le prompt' }).click()
  // Sans curseur posé, le champ s'ajoute à la fin du prompt, pas au début.
  assert.match(await page.getByLabel('Prompt', { exact: true }).inputValue(), /l'issue\. \{\{payload\.repository\}\}$/)
  await bench.getByRole('button', { name: 'Filtrer sur payload.sender.login', exact: true }).click()
  const paths = await page.getByLabel('Champ').evaluateAll((inputs) => inputs.map((input) => input.value))
  assert.ok(paths.includes('payload.sender.login'), paths.join(', '))

  // Un script qui écarte l'appel : le banc le dit aussitôt, et montre ce qu'il rend.
  await page.getByRole('button', { name: 'Ajouter un script' }).click()
  const editor = page.getByRole('region', { name: 'Déclencher' }).locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type("export default (event) => event.payload.sender.login === 'alex' ? { skip: 'auteur exclu' } : { vars: {} }")
  await bench.getByText('Cet appel serait ignoré. Écarté par le script : auteur exclu').waitFor({ timeout: 10000 })
  await bench.getByRole('tab', { name: 'Script' }).click()
  assert.match(await bench.locator('pre').first().textContent(), /"skip": "auteur exclu"/)
  await page.screenshot({ path: join(shots, 'automations-script.png') })

  // La session se règle aussi ici : durée maximale.
  await page.getByLabel('Durée maximale (min)').fill('20')
  await page.getByRole('region', { name: 'Lancer' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, 'automations-session.png') })

  // Enregistrer, puis relire : les réglages ont tenu.
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.getByText('Modifications non enregistrées').waitFor({ state: 'detached' })
  const saved = (await (await context.request.get(`${base}/api/schedules`)).json()).find((task) => task.id === taskId)
  assert.ok(saved.webhook.script.includes('auteur exclu'))
  assert.ok(saved.webhook.conditions.rules.some((rule) => rule.path === 'payload.sender.login' && rule.value === 'alex'))
  assert.match(saved.prompt, /\{\{payload\.repository\}\}/)
  assert.equal(saved.maxDurationMinutes, 20)

  // Le nom se change dans l'en-tête, d'un clic.
  await page.getByRole('heading', { name: 'Issues étiquetées' }).getByRole('button').click()
  await page.getByLabel('Nom', { exact: true }).fill('Issues à traiter')
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'Issues à traiter' }).waitFor()

  // En anglais : les raisons du journal et le script de départ suivent la langue de
  // l'interface, le serveur n'envoie que des codes.
  const english = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  await english.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'en')
  }, new URL(base).origin)
  await english.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const en = await english.newPage()
  en.on('pageerror', (error) => errors.push(error.message))
  await en.goto(`${base}/p/${project.id}/schedules/${taskId}`)
  await en.getByRole('tab', { name: /Log/ }).click()
  await en.getByText('Condition 1 not met: `headers.x-github-event` is “ping”.').first().waitFor()
  await en.getByRole('button', { name: 'Remove', exact: true }).click()
  await en.getByRole('button', { name: 'Add a script' }).click()
  assert.match(await en.locator('.cm-content').textContent(), /Receives the call/)
  await english.close()

  // Au téléphone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await phone.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  await phone.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const mobile = await phone.newPage()
  mobile.on('pageerror', (error) => errors.push(error.message))
  await mobile.goto(`${base}/p/${project.id}/schedules/${taskId}`)
  await mobile.getByRole('region', { name: 'Banc d’essai' }).waitFor()
  await mobile.screenshot({ path: join(shots, 'automations-phone.png') })
  await mobile.goto(`${base}/p/${project.id}/schedules`)
  await mobile.getByRole('heading', { name: 'Issues à traiter' }).waitFor()
  await mobile.screenshot({ path: join(shots, 'automations-list-phone.png') })

  assert.deepEqual(errors, [])
  console.log(`automations-ui-check: ok — captures dans ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
