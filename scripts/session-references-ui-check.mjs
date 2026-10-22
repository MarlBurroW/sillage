import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Session references through real UI/API and disposable data. No CLI enabled.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-ui-check-'))
const processes = []
let browser
let debugPage

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

function run(args, cwd, env, stdio = 'pipe') {
  const child = spawn(process.execPath, args, { cwd, env, stdio })
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
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok'].map(agent => '[agents.' + agent + ']\nenabled = false\n').join(''))
  const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: join(data, 'web') }
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = 'http://127.0.0.1:' + webPort
  await Promise.all([ready('http://127.0.0.1:' + apiPort + '/api/health', server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] })
  await context.addInitScript(() => { localStorage.setItem('sillage.locale', 'fr'); localStorage.setItem('sillage.theme', 'dark') })
  assert.ok((await context.request.post(base + '/api/auth/login', { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const projects = await (await context.request.get(base + '/api/projects')).json()
  const project = projects.find(entry => entry.name === 'Nimbus')
  const hero = randomUUID(), target = randomUUID(), archived = randomUUID(), missing = randomUUID(), sibling = randomUUID()
  const title = 'Décisions de navigation'
  const ref = 'session:' + target
  const thread = '/p/' + project.id + '/c/' + hero
  const targetHref = '/p/' + project.id + '/c/' + target
  const fixture = {
    hero, target, archived, sibling, project: project.id, title,
    text: [
      'Référence : ' + ref,
      'Identifiant : ' + target,
      '[Décision](' + ref + ')',
      'Adresse : ' + base + targetHref,
      '| Session | Note |\n| --- | --- |\n| ' + ref + ' | Tableau |',
      String.fromCharCode(96) + ref + String.fromCharCode(96),
      'Supprimée : session:' + missing,
      'Archive : session:' + archived,
      'Adresse externe : https://foreign.example' + targetHref,
      String.fromCharCode(96).repeat(3) + '\n' + ref + '\n' + String.fromCharCode(96).repeat(3),
    ].join('\n\n'),
  }
  const setupCode = [
    "import { openDatabase, conversations, projects } from '@sillage/db'",
    "import { DEFAULT_CODEX_CONFIG } from '@sillage/protocol'",
    "import { EventLog } from './src/events/event-log.ts'",
    "import { eq } from 'drizzle-orm'",
    "const [dbPath, raw] = process.argv.slice(1); const f = JSON.parse(raw)",
    "const { db, sqlite } = openDatabase(dbPath)",
    "const owner = db.select().from(projects).where(eq(projects.id, f.project)).get().ownerId",
    "for (const [id, title, archivedAt] of [[f.hero,'Références de sessions',null],[f.target,f.title,null],[f.archived,'Anciennes décisions',1],[f.sibling,'Temporary sibling',null]]) db.insert(conversations).values({id, title, projectId:f.project, userId:owner, agent:'codex', config:JSON.stringify(DEFAULT_CODEX_CONFIG),status:'idle',archivedAt,createdAt:Date.now(),updatedAt:Date.now()}).run()",
    "const log = new EventLog(db)",
    "log.append(f.hero,{type:'message.completed',messageId:'user',role:'user',blocks:[{type:'text',text:'Consulte session:'+f.target}],parentToolCallId:null})",
    "log.append(f.hero,{type:'message.completed',messageId:'assistant',role:'assistant',blocks:[{type:'text',text:f.text}],parentToolCallId:null})",
    "sqlite.close()",
  ].join('\n')
  const setup = run(['--import', 'tsx', '--input-type=module', '-e', setupCode, join(data, 'data/sillage.db'), JSON.stringify(fixture)], serverDir, env)
  assert.equal((await once(setup, 'exit'))[0], 0, setup.diagnostics)
  const page = await context.newPage()
  debugPage = page
  page.setDefaultTimeout(12000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const shots = process.env.SILLAGE_UI_SHOTS || '/var/tmp/sillage-session-references-shots'
  await mkdir(shots, { recursive: true })
  await page.goto(base + thread)
  const links = page.locator('.sg-reading [data-session-reference="' + target + '"] .sg-session-link')
  await links.first().waitFor()
  assert.equal(await links.count(), 7, 'user, text, UUID, Markdown link, URL, table and code span')
  await page.getByText('Session indisponible', { exact: true }).waitFor()
  assert.equal(await page.locator('.sg-reading [data-session-reference="' + archived + '"]').count(), 1)
  assert.equal(await page.locator('a[href^="https://foreign.example"]').count(), 1)
  assert.ok(await page.locator('pre').filter({ hasText: ref }).count())
  const downloadReady = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Télécharger en CSV', exact: true }).click()
  const csv = await downloadReady
  assert.ok((await readFile(await csv.path(), 'utf8')).includes(ref), 'CSV retains the reference identifier')
  assert.equal(await page.locator('.sg-reading [data-session-reference="' + target + '"] svg').count(), 14, 'CLI mark and info icon')
  await links.first().scrollIntoViewIfNeeded()
  await links.first().hover()
  const tooltip = page.getByRole('tooltip').filter({ hasText: title })
  await tooltip.waitFor()
  await tooltip.getByText('Codex', { exact: true }).waitFor()
  await page.screenshot({ path: join(shots, 'desktop-preview.png') })
  await page.keyboard.press('Escape')
  await page.mouse.move(900, 20)
  await links.first().focus()
  await tooltip.waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.sg-reading [data-session-reference="' + target + '"] .sg-session-info').first().click()
  await page.getByRole('dialog', { name: 'Détails de ' + title }).waitFor()
  assert.ok(page.url().endsWith(thread))
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Détails de ' + title }).waitFor({ state: 'hidden' })

  const composer = page.getByPlaceholder(/Écris ton message/)
  const insert = page.getByRole('button', { name: 'Insérer — aides de saisie', exact: true })
  await composer.fill('Consulte cette session')
  await composer.evaluate(node => node.setSelectionRange(9, node.value.length))
  await insert.click()
  const help = page.getByRole('dialog', { name: 'Aides de saisie', exact: true })
  await help.waitFor()
  for (const label of ['Fichier', 'Session', 'Ticket']) await help.getByRole('button', { name: label, exact: true }).waitFor()
  await page.screenshot({ path: join(shots, 'desktop-insert.png') })
  await help.getByRole('button', { name: 'Session', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.value === 'Consulte @@')
  await page.getByRole('listbox', { name: 'Sessions de ce projet' }).waitFor()
  await composer.press('Escape')
  for (const [label, prefix] of [['Fichier', '@'], ['Ticket', '#']]) {
    await composer.fill('Voir')
    await insert.click()
    await help.getByRole('button', { name: label, exact: true }).click()
    await page.waitForFunction(expected => document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.value === expected, 'Voir ' + prefix)
    await composer.press('Escape')
  }
  await composer.fill('Consulte @@decisions de nav')
  const picker = page.getByRole('listbox', { name: 'Sessions de ce projet' })
  await picker.getByRole('option').filter({ hasText: title }).waitFor()
  await composer.press('Enter')
  assert.equal(await composer.inputValue(), 'Consulte ' + ref + ' ')
  await page.getByLabel('Sessions référencées').getByRole('link', { name: /Décisions de navigation/ }).waitFor()
  await composer.fill('@@anciennes')
  await picker.getByRole('option').filter({ hasText: 'Anciennes décisions' }).waitFor()
  await composer.press('Tab')
  assert.equal(await composer.inputValue(), 'session:' + archived + ' ')
  await composer.fill('@@aucun-resultat')
  await page.getByText('Aucune session ne correspond.', { exact: true }).waitFor()
  await composer.press('Escape')
  await picker.waitFor({ state: 'hidden' })
  await composer.fill('Brouillon à conserver')

  // Clipboard action is available in both the ellipsis and context menu.
  const row = page.locator('[data-sidebar-session="' + target + '"]')
  await row.hover()
  await row.locator('.sidebar-session-menu').click()
  await page.getByRole('menuitem', { name: 'Copier la référence', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Référence copiée', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ref)
  await page.keyboard.press('Escape')
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copier la référence', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await links.first().click()
  await page.waitForURL(base + targetHref)
  await page.goBack()
  await composer.waitFor()
  assert.equal(await composer.inputValue(), 'Brouillon à conserver')

  // Clipboard paste works even without selecting from the picker; outgoing URLs normalize.
  let sent
  await page.route('**/api/conversations/' + hero + '/messages', async route => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true } })
  })
  await composer.fill('')
  await composer.focus()
  await page.keyboard.press('Control+V')
  assert.equal(await composer.inputValue(), ref)
  await page.getByLabel('Sessions référencées').getByRole('link', { name: /Décisions de navigation/ }).waitFor()
  await composer.fill('Voir ' + base + targetHref)
  await composer.press('Enter')
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '')
  assert.equal(sent.text, 'Voir ' + ref)
  assert.deepEqual(sent.mentions, [])

  // List updates must preserve mounted reference links and their open details, including when
  // another session disappears. Replacing equal HTML would also discard text selections.
  const referenceLink = await links.first().elementHandle()
  await page.locator('.sg-reading [data-session-reference="' + target + '"] .sg-session-info').first().click()
  await page.getByRole('dialog', { name: 'Détails de ' + title }).waitFor()
  assert.ok((await context.request.delete(base + '/api/conversations/' + sibling)).ok())
  await page.locator('[data-sidebar-session="' + sibling + '"]').waitFor({ state: 'hidden' })
  assert.ok(await referenceLink.evaluate(node => node.isConnected), 'Unrelated removal retains reference DOM')
  await page.getByRole('dialog', { name: 'Détails de ' + title }).waitFor()

  // Renames update references in place, while archives preserve access.
  assert.ok((await context.request.patch(base + '/api/conversations/' + target, { data: { title: 'Navigation renommée', archived: true } })).ok())
  await links.first().getByText('Navigation renommée', { exact: true }).waitFor()
  assert.ok(await referenceLink.evaluate(node => node.isConnected), 'Renaming retains reference DOM')
  await page.getByRole('dialog', { name: 'Détails de Navigation renommée' }).waitFor()
  await page.keyboard.press('Escape')

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  await mobile.addCookies(await context.cookies())
  await mobile.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const phone = await mobile.newPage()
  phone.on('pageerror', error => errors.push(error.message))
  await phone.goto(base + thread)
  const phoneRef = phone.locator('.sg-reading [data-session-reference="' + target + '"]').first()
  await phoneRef.locator('.sg-session-info').tap()
  const detail = phone.getByRole('dialog', { name: 'Détails de Navigation renommée' })
  await detail.waitFor()
  assert.ok(phone.url().endsWith(thread))
  const bounds = await detail.boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390)
  await phone.screenshot({ path: join(shots, 'phone-preview.png') })
  await detail.getByRole('button', { name: 'Fermer', exact: true }).tap()
  const phoneComposer = phone.getByPlaceholder(/Écris ton message/)
  await phoneComposer.fill('Consulte')
  await phone.getByRole('button', { name: 'Insérer — aides de saisie', exact: true }).tap()
  const phoneHelp = phone.getByRole('dialog', { name: 'Aides de saisie', exact: true })
  await phoneHelp.waitFor()
  await phone.screenshot({ path: join(shots, 'phone-insert.png') })
  const helpBounds = await phoneHelp.boundingBox()
  assert.ok(helpBounds.x >= 0 && helpBounds.y >= 0 && helpBounds.x + helpBounds.width <= 390)
  await phoneHelp.getByRole('button', { name: 'Session', exact: true }).tap()
  await phone.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.value === 'Consulte @@')
  await phoneComposer.pressSequentially('anciennes')
  await phone.getByRole('option').filter({ hasText: 'Anciennes décisions' }).tap()
  assert.equal(await phoneComposer.inputValue(), 'Consulte session:' + archived + ' ')
  await phone.screenshot({ path: join(shots, 'phone-composer.png') })
  await mobile.close()

  // Deleted targets become unavailable without dangling navigation.
  assert.ok((await context.request.delete(base + '/api/conversations/' + target)).ok())
  await page.reload()
  await page.getByText('Session indisponible', { exact: true }).first().waitFor()
  assert.equal(await links.count(), 0)
  assert.equal(await page.locator('.sg-reading [data-session-reference="' + archived + '"]').count(), 1)

  await context.close()
  const stopped = once(server, 'exit')
  server.kill('SIGTERM')
  await stopped
  const webDist = join(data, 'web-dist')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', webDist], webDir, { ...env, NODE_ENV: 'production' })
  assert.equal((await once(build, 'exit'))[0], 0, build.diagnostics)
  const desktop = run(['--import', 'tsx', 'src/main.ts'], serverDir, { ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3', SILLAGE_PORT: String(await freePort()), SILLAGE_WEB_ROOT: webDist }, ['pipe', 'pipe', 'pipe', 'pipe'])
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    desktop.stdio[3].setEncoding('utf8')
    desktop.stdio[3].on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))) })
    desktop.once('exit', () => reject(new Error(desktop.diagnostics)))
  })
  const desktopBase = 'http://127.0.0.1:' + handshake.port
  const local = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await local.addCookies([{ name: 'sillage_session', value: handshake.session, url: desktopBase }])
  await local.addInitScript(() => localStorage.setItem('sillage.locale', 'en'))
  const desk = await local.newPage()
  desk.on('pageerror', error => errors.push(error.message))
  await desk.goto(desktopBase + thread)
  await desk.locator('.sg-reading [data-session-reference="' + archived + '"] .sg-session-info').click()
  await desk.getByRole('dialog', { name: 'Details for Anciennes décisions' }).waitFor()
  await desk.getByRole('link', { name: 'Open session', exact: true }).waitFor()
  await desk.screenshot({ path: join(shots, 'desktop-edition.png') })
  assert.equal(await desk.getByRole('button', { name: 'Account menu' }).count(), 0)
  await desk.keyboard.press('Escape')
  await desk.getByRole('button', { name: 'Insert — typing shortcuts', exact: true }).click()
  const desktopHelp = desk.getByRole('dialog', { name: 'Typing shortcuts', exact: true })
  await desktopHelp.getByRole('button', { name: 'Session', exact: true }).click()
  await desk.getByRole('listbox', { name: 'Sessions in this project' }).waitFor()
  assert.deepEqual(errors, [])
  console.log('Session references verified: autocomplete, copy/paste, Markdown, shared previews, navigation, archives, deletion, touch, Server and Desktop. Screenshots: ' + shots)
} catch (error) {
  if (debugPage && !debugPage.isClosed()) { console.error(await debugPage.locator('body').innerText()); await debugPage.screenshot({ path: '/var/tmp/sillage-session-references-failure.png' }) }
  throw error
} finally {
  await browser?.close()
  await Promise.all(processes.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}

