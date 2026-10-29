import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

// Runs the production bundles and their worker, including PWA routing and Desktop's handshake.
// Every account, conversation and credential below belongs to a disposable fixture.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const data = await mkdtemp(join(tmpdir(), 'sillage-export-ui-'))
const shots = process.env.SILLAGE_EXPORT_SHOTS ?? join(data, 'shots')
const children = []
let browser, lastPage
await mkdir(shots, { recursive: true })
function run(args, env, stdio = 'pipe', executable = process.execPath, cwd = serverDir) {
  const child = spawn(executable, args, { cwd, env, stdio })
  children.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.diagnostics = (child.diagnostics + chunk).slice(-8000) })
  return child
}
async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}
async function ready(base, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error(child.diagnostics)
    if (await fetch(base + '/api/health').then(response => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw Error(child.diagnostics)
}
const seed = String.raw`
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openDatabase, runMigrations, users, projects, conversations } from '@sillage/db'
import { sillageEventSchema, defaultConfigFor } from '@sillage/protocol'
import { loadConfig } from './src/config.ts'
import { hashPassword } from './src/auth/passwords.ts'
import { EventLog } from './src/events/event-log.ts'
const config = loadConfig()
await mkdir(config.paths.data, { recursive: true })
const workspace = join(config.paths.data, 'workspace')
await mkdir(workspace)
const { db, sqlite } = openDatabase(config.paths.database)
runMigrations(db, join(process.cwd(), '../../packages/db/migrations'))
const now = Date.now()
db.insert(users).values({ id: 'export-owner', username: 'alex', displayName: 'Alex', passwordHash: await hashPassword('fixture-password'), isAdmin: true, createdAt: now }).run()
db.insert(projects).values({ id: 'export-project', name: 'Atelier', workspacePath: workspace, ownerId: 'export-owner', visibility: 'private', createdAt: now }).run()
db.insert(conversations).values({ id: 'export-session', projectId: 'export-project', userId: 'export-owner', title: 'Rendre une application utilisable hors ligne', agent: 'codex', config: JSON.stringify(defaultConfigFor('codex')), status: 'idle', createdAt: now, updatedAt: now }).run()
const log = new EventLog(db)
log.thread.stop()
const add = event => log.append('export-session', sillageEventSchema.parse(event))
const message = (id, role, text) => add({ type: 'message.completed', messageId: id, role, blocks: [{ type: 'text', text }], parentToolCallId: null })
message('before', 'user', 'BEFORE_RANGE_PRIVATE')
message('question', 'user', 'Je veux pouvoir consulter les prévisions météo même sans réseau. On commence par quoi ?')
message('answer', 'assistant', 'Le plus utile est de conserver la dernière prévision reçue. Je vais vérifier le chargement des données, puis ajouter un cache avec une date de mise à jour.\n\nOn gardera un indicateur discret pour distinguer les données enregistrées.')
add({ type: 'tool.started', toolCallId: 'tool', name: 'Bash', title: 'PRIVATE_TOOL_TITLE', input: { command: 'PRIVATE_COMMAND', description: 'PRIVATE_TOOL_TITLE' }, parentToolCallId: null })
add({ type: 'tool.completed', toolCallId: 'tool', output: 'Tests: 12 passed\npassword="fixture-secret-92741"\nSupport: public@example.test\n/home/alex/private/config\n192.168.12.4', isError: false, durationMs: 21 })
message('omit', 'user', 'REMOVE_THIS_MESSAGE')
message('decision', 'user', 'Oui, garde les prévisions précédentes et affiche la date. Je préfère un petit indicateur à une bannière qui prend toute la place.')
message('final', 'assistant', 'Le cache est en place. À la prochaine ouverture hors ligne, les dernières prévisions restent disponibles.\n\n| Situation | Ce que tu vois |\n| --- | --- |\n| Avec réseau | Prévisions à jour |\n| Sans réseau | Dernière prévision et sa date |\n\nLes 12 tests passent, y compris la reprise après une coupure.\n\n![Aperçu du résultat](preview.png)\n![Ne pas charger](https://attacker.example/tracking.png)\n<script>window.EXFILTRATE=1</script>\n[Interne](/api/settings)')
message('after', 'user', 'AFTER_RANGE_PRIVATE')
await writeFile(join(workspace, 'preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
sqlite.close()
`
try {
  if (!process.env.SILLAGE_EXPORT_SKIP_BUILD) {
    for (const name of ['@sillage/server', '@sillage/web']) {
      const build = run(['--filter', name, 'build'], { ...process.env, NODE_ENV: 'production' }, 'pipe', 'pnpm', root)
      assert.equal((await once(build, 'exit'))[0], 0, build.diagnostics)
    }
  }
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const profile of ['server', 'desktop']) {
    const port = await freePort(), base = 'http://127.0.0.1:' + port
    const config = join(data, profile + '.toml')
    await writeFile(config, '[server]\npublicUrl = "https://shared.example.test"\n' +
      ['claude', 'codex', 'opencode', 'grok', 'antigravity'].map(agent => '[agents.' + agent + ']\nenabled = false\n').join(''))
    const env = { ...process.env, NODE_ENV: 'development', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, profile),
      SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_WEB_ROOT: join(root, 'apps/web/dist') }
    delete env.SILLAGE_PROFILE
    delete env.SILLAGE_HANDSHAKE_FD
    const seeder = run(['--import', 'tsx', '--input-type=module', '-e', seed], env)
    assert.equal((await once(seeder, 'exit'))[0], 0, seeder.diagnostics)
    if (profile === 'desktop') { env.SILLAGE_PROFILE = 'desktop'; env.SILLAGE_HANDSHAKE_FD = '3' }
    const server = run(['dist/main.js'], env, ['pipe', 'pipe', 'pipe', 'pipe'])
    const handshake = profile === 'desktop' ? new Promise(resolve => {
      let output = ''
      server.stdio[3].on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output)) })
    }) : null
    await ready(base, server)
    for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, locale: 'fr-FR', colorScheme: 'light', serviceWorkers: 'allow', acceptDownloads: true })
      await context.addInitScript(() => {
        // Do not inject test setup into sandboxed export documents.
        if (!location.pathname.startsWith('/p/')) return
        localStorage.setItem('sillage.locale', 'fr'); localStorage.setItem('sillage.theme', 'light')
      })
      if (handshake) await context.addCookies([{ name: 'sillage_session', value: (await handshake).session, url: base, httpOnly: true, sameSite: 'Lax' }])
      else assert.ok((await context.request.post(base + '/api/auth/login', { data: { username: 'alex', password: 'fixture-password' } })).ok())
      const source = await context.request.get(base + '/api/conversations/export-session')
      assert.equal(source.status(), 200, await source.text())
      const page = await context.newPage(), errors = []
      page.setDefaultTimeout(15_000)
      lastPage = page
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(base + '/p/export-project/c/export-session')
      let pollingInterrupted = false, createdDrafts = 0
      page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/conversations/export-session/exports')) createdDrafts++ })
      await page.route(/\/api\/exports\/[^/]+$/, async route => {
        if (!pollingInterrupted && route.request().method() === 'GET') {
          pollingInterrupted = true
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'fixture_unavailable', message: 'Fixture connection interruption' } }) })
        } else await route.continue()
      })
      await page.getByRole('button', { name: 'Exporter et partager', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Exporter et partager', exact: true })
      const settings = dialog.locator('summary').filter({ hasText: 'Présentation et outils' })
      if (size === 'phone') await settings.click()
      await dialog.getByLabel('Titre', { exact: true }).fill('Construire ensemble, même hors ligne')
      await dialog.getByLabel('Introduction (facultative)').fill('Une séance de travail sur PROJET-ORION : partir d’un besoin, choisir une approche, puis vérifier le résultat.')
      await dialog.getByLabel('Pseudonyme (facultatif)').fill('Alex')
      if (size === 'phone') await settings.click()
      const item = text => dialog.locator('[data-export-item]').filter({ hasText: text })
      await item('AFTER_RANGE_PRIVATE').waitFor()
      // Empty selections and search filters must never misrepresent the exported content.
      const include = dialog.locator('[data-export-item]').getByRole('checkbox', { name: 'Inclure cet élément', exact: true })
      for (const checkbox of await include.all()) await checkbox.uncheck()
      await dialog.getByText('Sélectionne au moins un message ou un appel d’outil pour continuer.', { exact: true }).waitFor()
      assert.equal(await dialog.getByRole('button', { name: 'Vérifier le contenu', exact: true }).isDisabled(), true)
      await dialog.getByRole('button', { name: /Rétablir les éléments décochés/ }).click()
      await dialog.getByText('Éléments inclus : 8 sur 8', { exact: true }).waitFor()
      await dialog.getByLabel('Retrouver un échange', { exact: true }).fill('no matching exchange')
      await dialog.getByText('Aucun échange trouvé. Ta sélection reste inchangée.', { exact: true }).waitFor()
      assert.equal(await dialog.getByRole('button', { name: 'Vérifier le contenu', exact: true }).isDisabled(), false)
      await dialog.getByText('Éléments inclus : 8 sur 8', { exact: true }).waitFor()
      await dialog.getByRole('button', { name: 'Effacer la recherche', exact: true }).click()
      await item('Je veux pouvoir').getByRole('button', { name: 'Commencer ici', exact: true }).click()
      await item('Le cache est en place').getByRole('button', { name: 'Terminer ici', exact: true }).click()
      await item('REMOVE_THIS_MESSAGE').getByRole('checkbox', { name: 'Inclure cet élément' }).uncheck()
      if (size === 'phone') await settings.click()
      await dialog.getByRole('combobox', { name: 'Activité des outils', exact: true }).click()
      await page.getByRole('option', { name: 'Détails choisis', exact: true }).click()
      await dialog.getByLabel('Inclure les sorties', { exact: true }).check()
      if (size === 'phone') await settings.click()
      // Images remain opt-in. The tiny fixture verifies the explicit per-image approval.
      await dialog.getByLabel('Aperçu du résultat', { exact: true }).check()
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), 'dialog fits ' + size)
      await dialog.getByRole('heading', { name: 'Plage de conversation', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shots, 'selection-' + profile + '-' + size + '.png') })
      await dialog.getByRole('button', { name: 'Vérifier le contenu' }).click()
      await dialog.getByRole('tab', { name: /Détections/ }).waitFor()
      const analyzeRequests = []
      page.on('request', request => { if (request.url().endsWith('/analyze')) analyzeRequests.push(request.url()) })
      await dialog.getByRole('button', { name: 'Masquer un mot ou une expression', exact: true }).click()
      const phrase = page.getByRole('dialog', { name: 'Masquer un mot ou une expression', exact: true })
      await phrase.getByLabel('Texte à masquer', { exact: true }).fill('PROJET-ORION')
      await phrase.getByText('Occurrences à masquer : 1', { exact: true }).waitFor()
      await phrase.getByRole('button', { name: 'Masquer les occurrences', exact: true }).click()
      // A deliberately public address can be kept after checking the original.
      const email = dialog.locator('[data-export-finding="email"]')
      await email.getByRole('button', { name: 'Voir l’original' }).click()
      await email.getByLabel('Masquer', { exact: true }).uncheck()
      await dialog.getByText('Visible dans l’export', { exact: true }).waitFor()
      assert.ok(await dialog.getByRole('heading', { name: 'Exporter et partager', exact: true }).evaluate(el => el.getBoundingClientRect().top >= 0), 'title remains in view')
      assert.equal(await dialog.evaluate(el => el.scrollTop), 0, 'dialog header remains fixed after nested dialogs')
      await page.screenshot({ path: join(shots, 'privacy-' + profile + '-' + size + '.png') })
      assert.equal(await dialog.getByRole('button', { name: 'Ouvrir l’aperçu final' }).isDisabled(), true)
      await dialog.getByRole('button', { name: 'Images à vérifier : 1', exact: true }).click()
      await dialog.getByRole('button', { name: 'Voir l’image en grand', exact: true }).click()
      await page.getByRole('dialog', { name: 'Aperçu du résultat', exact: true }).getByRole('button', { name: 'Fermer', exact: true }).click()
      await dialog.getByLabel('J’ai vérifié les informations privées dans cette image').check()
      // Returning without edits must neither rescan nor lose decisions.
      await dialog.getByRole('button', { name: 'Contenu', exact: true }).click()
      await dialog.getByRole('button', { name: 'Vérifier le contenu' }).click()
      assert.equal(analyzeRequests.length, 0)
      assert.equal(await dialog.getByLabel('J’ai vérifié les informations privées dans cette image').isChecked(), true)
      // Editing a different field rescans while retaining decisions for unchanged text.
      await dialog.getByRole('button', { name: 'Contenu', exact: true }).click()
      if (size === 'phone') await settings.click()
      await dialog.getByLabel('Pseudonyme (facultatif)').fill('Alex M.')
      await dialog.getByRole('button', { name: 'Vérifier le contenu' }).click()
      await dialog.getByText('Contenu vérifié à nouveau. Tes choix sont conservés lorsque le texte est inchangé.', { exact: true }).waitFor()
      assert.equal(analyzeRequests.length, 1)
      assert.equal(await dialog.locator('[data-export-finding="email"]').getByLabel('Masquer', { exact: true }).isChecked(), false)
      await dialog.getByRole('tab', { name: /Détections/ }).focus()
      await page.keyboard.press('ArrowRight')
      assert.equal(await dialog.getByRole('tab', { name: 'Tout le texte', exact: true }).getAttribute('aria-selected'), 'true')
      const intro = dialog.locator('[data-export-field="introduction"]')
      assert.ok(!(await intro.innerText()).includes('PROJET-ORION'), 'review excerpt stays masked')
      await intro.locator('summary').click()
      await intro.getByRole('button', { name: 'Retirer ce masquage manuel', exact: true }).waitFor()
      // Text selection remains available alongside the mobile-friendly phrase input.
      const original = intro.getByLabel('Texte original (relecture privée uniquement)')
      await original.evaluate(el => { const start = el.value.indexOf('séance'); el.focus(); el.setSelectionRange(start, start + 5) })
      await original.press('Shift+ArrowRight')
      await intro.getByRole('button', { name: 'Masquer la sélection', exact: true }).click()
      await dialog.getByRole('tab', { name: /Détections/ }).click()
      await dialog.getByRole('button', { name: 'Ouvrir l’aperçu final' }).click()
      const preview = page.frameLocator('iframe[title="Aperçu de l’export"]')
      await preview.getByRole('heading', { name: 'Construire ensemble, même hors ligne', exact: true }).waitFor()
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), 'preview fits ' + size)
      await page.screenshot({ path: join(shots, 'preview-' + profile + '-' + size + '.png') })
      const initialHeight = await dialog.locator('iframe').evaluate(el => el.clientHeight)
      await dialog.getByRole('button', { name: 'Agrandir l’aperçu', exact: true }).click()
      assert.ok(await dialog.locator('iframe').evaluate(el => el.clientHeight) > initialHeight + 100, 'expanded preview gives reading space')
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.screenshot({ path: join(shots, 'expanded-' + profile + '-' + size + '.png') })
      await dialog.getByRole('button', { name: 'Retour', exact: true }).click()
      const downloading = page.waitForEvent('download')
      await dialog.getByRole('link', { name: 'Télécharger le HTML' }).click()
      const download = await downloading
      const artifact = join(shots, 'session-' + profile + '-' + size + '.html')
      await download.saveAs(artifact)
      const html = await readFile(artifact, 'utf8')
      for (const text of ['BEFORE_RANGE_PRIVATE', 'AFTER_RANGE_PRIVATE', 'REMOVE_THIS_MESSAGE', 'PRIVATE_COMMAND', 'PRIVATE_TOOL_TITLE', 'fixture-secret-92741', '/home/alex/private', '192.168.12.4', 'PROJET-ORION', 'attacker.example']) {
        assert.ok(!html.includes(text), 'excluded: ' + text)
      }
      assert.ok(html.includes('public@example.test'))
      assert.ok(html.includes('data:image/png;base64,'))
      const offline = await browser.newContext({ viewport, offline: true, colorScheme: 'light' })
      const file = await offline.newPage(), outgoing = []
      file.on('request', req => { if (/^https?:/.test(req.url())) outgoing.push(req.url()) })
      await file.goto(pathToFileURL(artifact).href)
      await file.getByRole('heading', { name: 'Construire ensemble, même hors ligne', exact: true }).waitFor()
      assert.equal(await file.evaluate(() => window.EXFILTRATE), undefined)
      assert.equal(await file.locator('a[href^="/api/"]').count(), 0)
      assert.ok(await file.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'export fits ' + size)
      assert.deepEqual(outgoing, [], 'HTML works without outgoing requests')
      await file.screenshot({ path: join(shots, 'export-' + profile + '-' + size + '.png'), fullPage: true })
      await offline.close()
      if (profile === 'server') {
        await dialog.getByRole('button', { name: 'Créer un lien public', exact: true }).click()
        const publication = page.getByRole('dialog', { name: 'Créer un lien public', exact: true })
        await publication.getByText(/copie figée/).waitFor()
        await publication.getByRole('button', { name: 'Créer un lien public', exact: true }).click()
        const link = dialog.getByRole('textbox', { name: 'Lien public créé' })
        await link.waitFor()
        const token = new URL(await link.inputValue()).pathname
        const anonymous = await browser.newContext({ viewport, serviceWorkers: 'allow' })
        const shared = await anonymous.newPage()
        const response = await shared.goto(base + token)
        assert.equal(response.status(), 200)
        assert.equal(await response.text(), html)
        assert.match(response.headers()['content-security-policy'], /sandbox/)
        await shared.getByRole('heading', { name: 'Construire ensemble, même hors ligne', exact: true }).waitFor()
        await anonymous.close()
        // An installed service worker must let both live and revoked public URLs reach the server.
        await page.evaluate(async () => { await navigator.serviceWorker.ready })
        const controlled = await context.newPage()
        const publicResponse = await controlled.goto(base + token)
        assert.equal(await publicResponse.text(), html)
        await controlled.close()
        await dialog.getByRole('tab', { name: 'Liens partagés' }).click()
        await dialog.getByRole('button', { name: 'Révoquer le lien', exact: true }).last().click()
        await page.getByRole('dialog', { name: 'Révoquer ce lien ?' }).getByRole('button', { name: 'Révoquer le lien', exact: true }).click()
        await dialog.getByText('Révoqué', { exact: false }).last().waitFor()
        assert.equal((await context.request.get(base + token)).status(), 404)
        const revoked = await context.newPage()
        assert.equal((await revoked.goto(base + token)).status(), 404)
        assert.equal(await revoked.locator('#root').count(), 0, 'PWA must not replace a revoked share with the app')
        await revoked.close()
      } else {
        assert.equal(await dialog.getByRole('button', { name: 'Créer un lien public', exact: true }).count(), 0)
        assert.equal(await dialog.getByRole('tab', { name: 'Liens partagés' }).count(), 0)
        await dialog.getByText('Télécharge le fichier HTML pour partager cette conversation depuis Desktop.').waitFor()
      }
      assert.ok(pollingInterrupted, 'transient polling failure was exercised')
      assert.equal(createdDrafts, 1, 'polling recovery keeps the existing draft')
      assert.deepEqual(errors, [])
      await dialog.getByRole('button', { name: 'Fermer', exact: true }).click()
      await context.close()
      console.log(profile + ' / ' + size + ': selection, redaction, images, preview, offline HTML and sharing passed')
    }
    server.kill('SIGTERM')
    await once(server, 'exit')
  }
  console.log('Screenshots: ' + shots)
} catch (error) {
  if (lastPage && !lastPage.isClosed()) {
    await lastPage.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
    console.error(lastPage.url(), (await lastPage.locator('body').innerText()).slice(0, 5000))
  }
  throw error
} finally {
  await browser?.close()
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
