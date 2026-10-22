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

// Webhook automations end to end: GitHub-template creation, signed received calls,
// explorer, live condition evaluation, script, save. No session starts: matching
// call arrives while paused; server trial reports that it would launch.
// Screenshots go to AUTOMATIONS_SHOTS or a temporary directory.
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

  // Create from GitHub “labeled issue” template.
  await page.goto(`${base}/p/${project.id}/schedules`)
  await page.getByRole('button', { name: 'Nouvelle automatisation' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Par un webhook/ }).click()
  // Form creates, page configures: template and name only.
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
  const configuration = page.getByRole('navigation', { name: 'Rubriques de configuration', exact: true })
  const views = page.getByRole('navigation', { name: 'Automatisation', exact: true })
  const go = async (name) => { await configuration.getByRole('link', { name, exact: true }).click() }
  for (const section of ['Connexion', 'Conditions', 'Prompt', 'Agent', 'Garde-fous']) {
    await go(section)
    await page.getByRole('region', { name: section, exact: true }).waitFor()
  }
  await go('Prompt')
  assert.match(await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), /Traite l'issue #\{\{payload\.issue\.number\}\}/)
  await go('Connexion')

  // Address and secret as copied into GitHub.
  const url = await page.locator('code').first().textContent()
  assert.match(url, /\/api\/hooks\/[\w-]{20,}$/)
  await page.getByRole('button', { name: 'Afficher le secret' }).click()
  await page.locator('code', { hasText: /^[0-9a-f]{64}$/ }).waitFor()

  // Test bench: without received calls, starts from template example and immediately
  // shows what automation would do, including rendered prompt.
  const bench = page.getByRole('region', { name: 'Banc d’essai' })
  await bench.getByText('Cet appel lancerait une session, sujet « 42 ».').waitFor({ timeout: 15000 })
  assert.equal(await page.locator('[aria-label="Non remplie"]').count(), 0)
  assert.match(await bench.locator('pre').first().textContent(), /Traite l'issue #42 « Crash on startup when the cache is empty »/)
  await bench.getByRole('switch', { name: 'Message complet' }).click()
  assert.match(await bench.locator('pre').first().textContent(), /\[Automatisation Sillage « Issues étiquetées »/)
  await bench.getByRole('switch', { name: 'Message complet' }).click()
  await page.screenshot({ path: join(shots, 'automations-launch.png') })

  // Example variant: another label; failed condition explains itself on both sides.
  const pick = async (name) => {
    await bench.getByRole('combobox', { name: 'Appel testé' }).click()
    await page.getByRole('option', { name }).click()
  }
  await go('Conditions')
  await pick('Exemple : GitHub : issue étiquetée « bug »')
  await bench.getByText('Cet appel serait ignoré. Condition 3 non remplie : `payload.label.name` vaut « bug ».').waitFor({ timeout: 15000 })
  assert.ok(await page.locator('[aria-label="Non remplie"]').count() >= 1)

  // Call can be edited in place: body scrolls in editor, verdict follows typing.
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

  // “Copy as curl”: server-signed command executed for real. Ping passes signature
  // then gets filtered: nothing launches, but entire HTTP path runs and call is journaled.
  await pick(/Exemple : GitHub : ping/)
  await bench.getByRole('tab', { name: 'Appel' }).click()
  await bench.getByRole('button', { name: 'Copier en curl' }).click()
  const command = await bench.locator('pre', { hasText: 'curl' }).textContent()
  assert.match(command, /x-hub-signature-256: sha256=[0-9a-f]{64}/)
  const output = execFileSync('bash', ['-c', command], { encoding: 'utf8' })
  assert.equal(JSON.parse(output).verdict, 'filtered', output)
  await views.getByRole('link', { name: 'Historique', exact: true }).click()
  const journal = page.getByRole('region', { name: 'Historique', exact: true })
  await journal.getByText('Condition 1 non remplie : `headers.x-github-event` vaut « ping ».').waitFor({ timeout: 15000 })
  await page.screenshot({ path: join(shots, 'automations-journal.png') })
  // Received call can be tested with one click, placing it on bench.
  await journal.getByRole('button', { name: 'Essayer' }).first().click()
  await bench.getByRole('combobox', { name: 'Appel testé' }).filter({ hasText: /Reçu .* : ping/ }).waitFor()
  await bench.getByText(/Cet appel serait ignoré\. Condition 1/).waitFor({ timeout: 15000 })

  // Return to passing example for subsequent checks.
  await pick('Exemple : GitHub : issue étiquetée « sillage »')
  await bench.getByText('Cet appel lancerait une session', { exact: false }).waitFor()

  // Explorer: filter a field, insert it into prompt.
  await bench.getByRole('tab', { name: 'Appel' }).click()
  await bench.getByRole('tab', { name: 'Explorer' }).click()
  await bench.getByRole('button', { name: 'Insérer {{payload.repository}} dans le prompt' }).click()
  // Without cursor position, field appends to prompt rather than prepending.
  assert.match(await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), /l'issue\. \{\{payload\.repository\}\}$/)
  await bench.getByRole('button', { name: 'Filtrer sur payload.sender.login', exact: true }).click()
  const paths = await page.getByLabel('Champ').evaluateAll((inputs) => inputs.map((input) => input.value))
  assert.ok(paths.includes('payload.sender.login'), paths.join(', '))

  // Script skipping call: bench says so immediately and shows its result.
  await page.getByRole('button', { name: 'Ajouter un script' }).click()
  const editor = page.getByRole('region', { name: 'Conditions', exact: true }).locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type("export default (event) => event.payload.sender.login === 'alex' ? { skip: 'auteur exclu' } : { vars: {} }")
  await bench.getByText('Cet appel serait ignoré. Écarté par le script : auteur exclu').waitFor({ timeout: 10000 })
  await bench.getByRole('tab', { name: 'Script' }).click()
  assert.match(await bench.locator('pre').first().textContent(), /"skip": "auteur exclu"/)
  await page.screenshot({ path: join(shots, 'automations-script.png') })

  // Session is configurable here too: maximum duration.
  await go('Garde-fous')
  await page.getByLabel('Durée maximale (min)').fill('20')
  await page.getByRole('region', { name: 'Garde-fous', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, 'automations-session.png') })

  // Save then reread: settings persisted.
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.getByText('Modifications non enregistrées').waitFor({ state: 'detached' })
  const saved = (await (await context.request.get(`${base}/api/schedules`)).json()).find((task) => task.id === taskId)
  assert.ok(saved.webhook.script.includes('auteur exclu'))
  assert.ok(saved.webhook.conditions.rules.some((rule) => rule.path === 'payload.sender.login' && rule.value === 'alex'))
  assert.match(saved.prompt, /\{\{payload\.repository\}\}/)
  assert.equal(saved.maxDurationMinutes, 20)

  // Rename from header with one click.
  await page.getByRole('heading', { name: 'Issues étiquetées' }).getByRole('button').click()
  await page.getByLabel('Nom', { exact: true }).fill('Issues à traiter')
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'Issues à traiter' }).waitFor()

  // English: journal reasons and starter script follow interface language;
  // server sends codes only.
  const english = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  await english.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'en')
  }, new URL(base).origin)
  await english.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const en = await english.newPage()
  en.on('pageerror', (error) => errors.push(error.message))
  await en.goto(`${base}/p/${project.id}/schedules/${taskId}`)
  await en.getByRole('navigation', { name: 'Automation', exact: true }).getByRole('link', { name: 'History', exact: true }).click()
  await en.getByText('Condition 1 not met: `headers.x-github-event` is “ping”.').first().waitFor()
  await en.getByRole('navigation', { name: 'Automation', exact: true }).getByRole('link', { name: 'Configuration', exact: true }).click()
  await en.getByRole('navigation', { name: 'Configuration sections', exact: true }).getByRole('link', { name: 'Conditions', exact: true }).click()
  await en.getByRole('button', { name: 'Remove', exact: true }).click()
  await en.getByRole('button', { name: 'Add a script' }).click()
  assert.match(await en.locator('.cm-content').textContent(), /Receives the call/)
  await english.close()

  // On a phone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await phone.addInitScript((origin) => {
    if (window === window.top && location.origin === origin) localStorage.setItem('sillage.locale', 'fr')
  }, new URL(base).origin)
  await phone.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const mobile = await phone.newPage()
  mobile.on('pageerror', (error) => errors.push(error.message))
  await mobile.goto(`${base}/p/${project.id}/schedules/${taskId}`)
  await mobile.getByRole('navigation', { name: 'Automatisation', exact: true }).getByRole('link', { name: 'Tester', exact: true }).click()
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
