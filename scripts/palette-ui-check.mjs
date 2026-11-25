import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Search palette using real API and demo data. No CLI enabled.
// --desktop uses the real Desktop profile and apps/web/dist, without Electron.
const desktop = process.argv.includes('--desktop')
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-palette-check-'))
// Screenshots only on request: `SHOTS=/a/directory node scripts/palette-ui-check.mjs`.
const shots = process.env.SHOTS
const processes = []
let browser
let page
const errors = []

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
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config,
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: desktop ? join(webDir, 'dist') : join(data, 'web'),
    SILLAGE_PROFILE: desktop ? 'desktop' : 'server',
    ...(desktop ? { SILLAGE_HANDSHAKE_FD: '3' } : {}),
  }
  // Desktop opens its launcher session for the seeded account, so its data exists before startup.
  // A server is seeded once running instead: working and waiting sessions then keep their state,
  // which the rows waiting on the user need.
  const seedData = async () => {
    const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
    const [seedCode] = await once(seed, 'exit')
    assert.equal(seedCode, 0, seed.diagnostics)
  }
  if (desktop) await seedData()
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env, desktop ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe')
  const handshake = desktop ? new Promise((resolve, reject) => {
    let buffer = ''
    server.stdio[3].on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]))
    })
    server.once('exit', () => reject(new Error(server.diagnostics)))
  }) : null
  const base = `http://127.0.0.1:${desktop ? apiPort : webPort}`
  const vite = desktop ? null : run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ...(vite ? [ready(base, vite)] : [])])
  if (!desktop) await seedData()

  if (shots) await mkdir(shots, { recursive: true })
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  if (desktop) await context.addCookies([{ name: 'sillage_session', value: (await handshake).session, url: base }])
  else {
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
  }
  const projects = await (await context.request.get(`${base}/api/projects`)).json()
  const nimbus = projects.find((entry) => entry.name === 'Nimbus')
  const atlas = projects.find((entry) => entry.name === 'Atlas API')
  const listConversations = async () => (await context.request.get(`${base}/api/projects/${nimbus.id}/conversations`)).json()
  const conversations = await listConversations()
  const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
  const release = conversations.find((entry) => entry.title === 'Release notes for v0.9')
  const skill = await context.request.post(`${base}/api/skill-library`, {
    data: { scope: 'project', projectId: nimbus.id, name: 'forecast-debugging', description: 'Use when a forecast is stale.', body: '' },
  })
  assert.ok(skill.ok(), await skill.text())

  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const palette = page.getByRole('dialog', { name: 'Rechercher', exact: true })
  const input = palette.getByRole('combobox')
  const token = palette.getByRole('button', { name: /^Ne plus chercher seulement dans/ })
  const offer = palette.getByRole('button', { name: /^Chercher seulement dans/ }).first()
  const stepToken = palette.getByRole('button', { name: /^Quitter «/ })
  // A group is named by its heading, or by its label when the token already names it.
  const groups = () => palette.getByRole('group').evaluateAll((nodes) => nodes.map((node) => {
    const heading = node.getAttribute('aria-labelledby')
    return heading ? document.getElementById(heading).innerText.split('\n')[0] : `(${node.getAttribute('aria-label')})`
  }))
  const options = () => palette.getByRole('option').allInnerTexts()
  const titles = async () => (await options()).map((text) => text.split('\n')[0])
  const selected = async () => (await palette.locator('[role=option][aria-selected=true]').innerText()).split('\n')[0]
  const search = async (text) => {
    await input.fill(text)
    // Ranking is deferred and files arrive from the server: wait for things to settle.
    await page.waitForTimeout(250)
    await palette.locator('svg.animate-spin').waitFor({ state: 'detached' })
  }
  /** Move the selection to the row with this title, the way a keyboard does. */
  const select = async (title) => {
    const all = await titles()
    const target = all.indexOf(title)
    assert.notEqual(target, -1, `${title} absent : ${all.join(' | ')}`)
    for (let guard = 0; guard < all.length && (await selected()) !== title; guard++) await page.keyboard.press('ArrowDown')
    assert.equal(await selected(), title)
  }

  // The shortcut is listened for only after app mount.
  const open = async (path) => {
    if (path) {
      await page.goto(`${base}${path}`)
      await page.getByRole('button', { name: /^Rechercher/ }).first().waitFor()
    }
    await page.keyboard.press('Control+k')
    await input.waitFor()
  }
  const close = async () => {
    await page.keyboard.press('Escape')
    await palette.waitFor({ state: 'detached' })
  }
  const heroPath = `/p/${nimbus.id}/c/${hero.id}`

  // --- The project token --------------------------------------------------------------------

  await open(heroPath)
  await palette.getByRole('option', { name: /Release notes for v0.9/ }).waitFor()

  // Opened in a project: its token is set, only its sessions are listed and the other projects are
  // named. The open session leads nowhere, and its concentration command stays the first row.
  assert.match(await token.innerText(), /Nimbus/)
  assert.equal(await selected(), 'Activer le mode concentration')
  const initial = await groups()
  assert.equal(initial[0], 'Cette session')
  assert.equal(initial.at(-1), 'Autres projets')
  assert.ok(initial.includes('Nimbus'), initial.join(', '))
  assert.equal(await palette.getByRole('option', { name: /Add offline caching/ }).count(), 0)
  assert.equal(await palette.getByRole('option', { name: /Fix the flaky retry test/ }).count(), 0)
  assert.ok((await titles()).includes('Atlas API'))
  // A working session says so on its row. A server seeded while running keeps that state.
  if (!desktop) {
    assert.equal(initial[1], 'À traiter', initial.join(', '))
    assert.match((await options()).find((text) => text.startsWith('Refactor settings storage')), /Attente de réponse/)
  }
  if (shots) await page.screenshot({ path: join(shots, 'palette-open.png') })

  // All types of the project, none from elsewhere, and a row that widens.
  await search('forecast')
  assert.equal((await groups())[0], '(Nimbus)')
  let rows = await options()
  for (const expected of ['forecast-debugging', 'Hourly forecast chart', 'forecast-cache.ts']) {
    assert.ok(rows.some((text) => text.includes(expected)), `${expected} absent : ${rows.join(' | ')}`)
  }
  // Named entities precede files.
  const kinds = rows.map((text) => text.split('\n').at(-1))
  assert.ok(kinds.indexOf('Fichier') > kinds.indexOf('Skill'), kinds.join(', '))
  if (shots) await page.screenshot({ path: join(shots, 'palette-forecast.png') })

  // Every project has a README: only this one's is listed, and the last row counts the others.
  await search('readme')
  rows = await options()
  assert.equal(rows.filter((text) => text.startsWith('README.md')).length, 1, rows.join(' | '))
  assert.match(rows.find((text) => text.startsWith('Chercher partout')) ?? '', /2 résultat\(s\) ailleurs/)
  // The widening row lifts the token and keeps the query; the shortcut switches back and forth.
  await select('Chercher partout')
  await page.keyboard.press('Enter')
  await token.waitFor({ state: 'detached' })
  assert.equal(await input.inputValue(), 'readme')
  await offer.waitFor()
  assert.ok((await groups()).includes('Atlas API'))
  assert.equal((await options()).filter((text) => text.startsWith('README.md')).length, 3)
  await page.keyboard.press('Control+k')
  await token.waitFor()
  assert.equal(await input.inputValue(), 'readme')

  // Another project by name, then Tab: it takes the token and the text has done its job.
  await search('atlas')
  assert.equal(await selected(), 'Atlas API')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() => document.querySelector('[role=dialog] [role=combobox]').value === '')
  assert.match(await token.innerText(), /Atlas API/)
  await palette.getByRole('option', { name: /Fix the flaky retry test/ }).waitFor()
  await search('board')
  assert.equal(await selected(), 'Board')

  // Backspace at the start of the field removes the token; a held key that emptied it does not.
  await search('x')
  await page.keyboard.down('Backspace')
  await page.keyboard.down('Backspace')
  await page.keyboard.up('Backspace')
  assert.equal(await input.inputValue(), '')
  assert.equal(await token.count(), 1)
  await page.keyboard.press('Backspace')
  await token.waitFor({ state: 'detached' })
  // The token comes back with the project it last held.
  await page.keyboard.press('Control+k')
  assert.match(await token.innerText(), /Atlas API/)
  await close()

  // Nothing in the project: the other projects' results rather than a dead end.
  await open()
  assert.match(await token.innerText(), /Nimbus/)
  await search('rate limit')
  await palette.getByText('Rien dans Nimbus. Résultats trouvés ailleurs :').waitFor()
  assert.ok((await titles()).includes('Rate-limit the places endpoint'))
  if (shots) await page.screenshot({ path: join(shots, 'palette-fallback.png') })

  // --- Without the token: every project ------------------------------------------------------

  // Project names restrict results; a type lists that type; general items have their own group.
  await page.keyboard.press('Control+k')
  await token.waitFor({ state: 'detached' })
  await search('atlas readme')
  assert.deepEqual((await groups()).filter((name) => name !== 'Créer'), ['Atlas API'])
  // An action from another project appears only when named with that project.
  await search('docs board')
  assert.deepEqual((await groups()).filter((name) => name !== 'Créer'), ['Docs'])
  await search('mcp')
  assert.ok((await groups()).includes('Général'))
  assert.ok((await options()).some((text) => text.includes('Serveurs MCP')))

  // Tab moves to the next group, Shift+Tab returns.
  await search('readme')
  assert.ok((await groups()).length > 1)
  const first = await selected()
  await page.keyboard.press('Tab')
  assert.notEqual(await palette.locator('[role=option][aria-selected=true]').evaluate((node) => node.closest('[role=group]').getAttribute('aria-labelledby')), await palette.locator('[role=option]').first().evaluate((node) => node.closest('[role=group]').getAttribute('aria-labelledby')))
  await page.keyboard.press('Shift+Tab')
  assert.equal(await selected(), first)

  // A project heading narrows to its project and keeps the query.
  await palette.getByRole('button', { name: /^Atlas API/ }).click()
  assert.match(await token.innerText(), /Atlas API/)
  assert.equal(await input.inputValue(), 'readme')

  // Expand a group by keyboard: selection moves to the first revealed result.
  await page.keyboard.press('Control+k')
  await search('nimbus')
  rows = await options()
  const more = rows.findIndex((text) => text.includes('de plus'))
  assert.ok(more > 0, rows.join(' | '))
  for (let index = 0; index < more; index++) {
    await page.keyboard.press('ArrowDown')
    await page.waitForFunction((index) => document.querySelector('[role=option][aria-selected=true]') === document.querySelectorAll('[role=option]')[index], index + 1)
  }
  await page.keyboard.press('Enter')
  await page.waitForFunction((count) => document.querySelectorAll('[role=dialog] [role=option]').length > count, rows.length)
  assert.equal(await palette.getByRole('option', { name: /de plus/ }).count(), 0)

  // Another project’s file opens its home view with the panel showing the file.
  await search('atlas readme')
  await page.keyboard.press('Enter')
  await page.locator('[data-panel="workspace"] [data-editor-file="README.md"]').waitFor()
  assert.equal(new URL(page.url()).pathname, `/p/${atlas.id}/c/new`)

  // A current-project file opens in the conversation panel with editor focus.
  await open(heroPath)
  await search('forecast-cache')
  assert.equal(await selected(), 'forecast-cache.ts')
  await page.keyboard.press('Enter')
  await palette.waitFor({ state: 'detached' })
  await page.locator('[data-editor-file="src/lib/forecast-cache.ts"] .cm-content:focus').waitFor()
  assert.equal(new URL(page.url()).pathname, heroPath)

  // --- Prefixes ------------------------------------------------------------------------------

  await open()
  await search('>')
  const commandGroups = await groups()
  assert.equal(commandGroups[0], 'Cette session')
  assert.ok(commandGroups.includes('Général'))
  assert.ok((await titles()).includes('Renommer la session...'))
  await search('#')
  rows = (await options()).filter((text) => !text.startsWith('Chercher partout'))
  assert.ok(rows.length > 3 && rows.every((text) => text.endsWith('Ticket')), rows.join(' | '))
  // Open tickets before closed ones.
  assert.ok(rows.findIndex((text) => text.includes('Terminé')) > rows.findIndex((text) => text.includes('À faire')), rows.join(' | '))
  await search('#chart')
  assert.equal(await selected(), '#3 Hourly forecast chart')
  await search('/fore')
  rows = (await options()).filter((text) => !text.startsWith('Chercher partout'))
  assert.ok(rows.length > 0 && rows.every((text) => text.endsWith('Fichier')), rows.join(' | '))
  await search('/')
  await palette.getByText('Tape un nom de fichier.').waitFor()

  // --- Commands of the open session ----------------------------------------------------------

  // Renaming is a step: the title is proposed, selected, and Enter applies the typed one.
  await search('renommer')
  assert.equal(await selected(), 'Renommer la session...')
  await page.keyboard.press('Enter')
  await stepToken.waitFor()
  assert.equal(await input.inputValue(), 'Add offline caching for forecasts')
  // Escape leaves the step, not the palette.
  await page.keyboard.press('Escape')
  await stepToken.waitFor({ state: 'detached' })
  assert.equal(await palette.count(), 1)
  await search('renommer')
  await page.keyboard.press('Enter')
  await stepToken.waitFor()
  await page.keyboard.type('Offline forecasts')
  await palette.getByRole('option', { name: 'Renommer en « Offline forecasts »' }).waitFor()
  await page.keyboard.press('Enter')
  await palette.waitFor({ state: 'detached' })
  await page.locator('.sg-conversation-heading').getByText('Offline forecasts', { exact: true }).waitFor()

  // A ticket is picked in a step listing the project's tickets.
  await open()
  await search('lier')
  assert.equal(await selected(), 'Lier à un autre ticket...')
  await page.keyboard.press('Enter')
  await stepToken.waitFor()
  await search('wind')
  assert.equal(await selected(), '#7 Wind direction arrows on the map')
  await page.keyboard.press('Enter')
  await palette.waitFor({ state: 'detached' })
  await page.locator('.sg-conversation-heading').getByText('Wind direction arrows on the map').waitFor()

  // An action of the page opens its dialog; a toggle acts at once.
  await open()
  await search('exporter')
  assert.equal(await selected(), 'Exporter et partager')
  await page.keyboard.press('Enter')
  await palette.waitFor({ state: 'detached' })
  const exportDialog = page.getByRole('dialog', { name: 'Exporter et partager' })
  await exportDialog.waitFor()
  assert.equal(await exportDialog.evaluate((node) => node.contains(document.activeElement)), true)
  await page.keyboard.press('Escape')
  await exportDialog.waitFor({ state: 'detached' })
  await open()
  await search('favori')
  assert.equal(await selected(), 'Mettre en favori')
  await page.keyboard.press('Enter')
  await palette.waitFor({ state: 'detached' })
  await page.waitForFunction(async (url) => (await (await fetch(url)).json()).some((entry) => entry.favorite), `${base}/api/projects/${nimbus.id}/conversations`)

  // Copying has no visible effect: the palette says it worked, then closes on its own.
  await open()
  await search('copier la référence')
  await page.keyboard.press('Enter')
  await palette.getByText('Référence copiée').waitFor()
  await palette.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `session:${hero.id}`)

  // --- Creating from the typed text ----------------------------------------------------------

  await open()
  await search('Tide table for harbours')
  assert.equal((await groups()).at(-1), 'Créer')
  await select('Nouveau ticket')
  await page.keyboard.press('Enter')
  await palette.getByText('Ticket créé. Tape le suivant, ou ouvre-le.').waitFor()
  // The palette stays open and empty for the next one; Enter opens the ticket just made.
  assert.equal(await input.inputValue(), '')
  assert.match(await selected(), /^#\d+ Tide table for harbours$/)
  const cards = await (await context.request.get(`${base}/api/projects/${nimbus.id}/cards`)).json()
  const created = cards.find((card) => card.title === 'Tide table for harbours')
  assert.ok(created)
  await page.keyboard.press('Enter')
  await page.waitForURL((url) => url.pathname === `/p/${nimbus.id}/board` && url.searchParams.get('carte') === String(created.number))

  await open()
  await search('Draft the harbour notes')
  await select('Nouvelle session')
  await page.keyboard.press('Enter')
  await page.waitForURL((url) => url.pathname === `/p/${nimbus.id}/c/new`)
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((node) => node.value === 'Draft the harbour notes'))

  // --- Beside the current view, habits, a command -------------------------------------------

  // The modifier opens a result's address without leaving this one.
  await open(heroPath)
  await search('release notes')
  assert.equal(await selected(), 'Release notes for v0.9')
  const [aside] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Control+Enter')])
  assert.equal(new URL(aside.url()).pathname, `/p/${nimbus.id}/c/${release.id}`)
  await aside.close()
  assert.equal(new URL(page.url()).pathname, heroPath)
  await palette.waitFor({ state: 'detached' })

  // What is picked often comes first among close matches.
  await open()
  await search('re')
  const before = (await titles()).filter((title) => title === 'Refactor settings storage' || title === 'Release notes for v0.9')
  assert.equal(before.length, 2, (await titles()).join(' | '))
  const lower = before[1]
  const lowerId = (await listConversations()).find((entry) => entry.title === lower).id
  await close()
  await page.evaluate((key) => localStorage.setItem('sillage.palette.usage', JSON.stringify({ [key]: { count: 40, at: Date.now() } })), `conversation:${lowerId}`)
  await open()
  await search('re')
  const after = (await titles()).filter((title) => before.includes(title))
  assert.deepEqual(after, [before[1], before[0]])
  // A pick is remembered.
  await select(lower)
  await page.keyboard.press('Enter')
  await palette.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem('sillage.palette.usage'))[key].count, `conversation:${lowerId}`), 41)

  // A command executes in place.
  await open()
  await search('thème sombre')
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')

  // Outside a project there is no token, and the shortcut closes as it always did.
  await open('/settings')
  await palette.getByRole('option').first().waitFor()
  assert.equal(await token.count() + await offer.count(), 0)
  await page.keyboard.press('Control+k')
  await palette.waitFor({ state: 'detached' })

  // Phone: fullscreen, close button, no overflow; the token goes and comes back in one tap.
  await page.setViewportSize({ width: 390, height: 844 })
  await open(heroPath)
  await search('forecast')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const box = await palette.boundingBox()
  assert.equal(Math.round(box.width), 390)
  if (shots) await page.screenshot({ path: join(shots, 'palette-mobile.png') })
  await token.click()
  await token.waitFor({ state: 'detached' })
  await offer.click()
  await token.waitFor()
  await palette.getByRole('button', { name: 'Fermer la recherche', exact: true }).click()
  await palette.waitFor({ state: 'detached' })

  assert.deepEqual(errors, [])
  console.log(`OK : jeton de projet (défaut, élargissement, Tab, retour arrière, repli), groupes par projet, préfixes, commandes de session et étapes, création depuis le texte, ouverture à côté, habitudes, fichiers dans le bon panneau, téléphone${shots ? ` ; captures dans ${shots}` : ''}`)
} catch (error) {
  // What the screen showed when a step failed says more than the assertion.
  if (shots && page) {
    await page.screenshot({ path: join(shots, 'palette-failure.png') }).catch(() => {})
    console.error(`Focus : ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200)).catch(() => '?')}`)
    if (errors.length > 0) console.error(`Erreurs de la page : ${errors.join(' | ')}`)
  }
  throw error
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(data, { recursive: true, force: true })
}
