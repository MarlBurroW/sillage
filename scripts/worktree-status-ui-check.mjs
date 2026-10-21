import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// L'avancement des worktrees sur la démo : vrai serveur, vrai git, base temporaire.
// La démo porte deux arbres créés par Sillage (« offline cache », non commité ; « radar
// prefetch », commité non fusionné) ; on y ajoute au shell un arbre externe fusionné et
// un arbre introuvable, comme les agents en laissent derrière eux.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-worktree-check-'))
const shots = join(tmpdir(), 'sillage-contextual-worktrees-ui')
const processes = []
let browser

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
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Server did not start: ${child.diagnostics}`)
}

try {
  await mkdir(shots, { recursive: true })
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Alex Demo',
    GIT_AUTHOR_EMAIL: 'alex@example.test',
    GIT_COMMITTER_NAME: 'Alex Demo',
    GIT_COMMITTER_EMAIL: 'alex@example.test',
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

  // Deux arbres de plus, créés au shell comme le font les agents : l'un fusionné par
  // squash (à nettoyer), l'autre dont le dossier a disparu (introuvable).
  const repoRoot = join(data, 'data', 'demo', 'nimbus')
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString().trim()
  const squashed = join(data, 'external', 'nimbus-squashed')
  git(repoRoot, 'worktree', 'add', '-b', 'fix/squashed-typo', squashed, 'main')
  await writeFile(join(squashed, 'TYPO.md'), 'fixed\n')
  git(squashed, 'add', '-A')
  git(squashed, 'commit', '-m', 'Fix a typo')
  git(repoRoot, 'merge', '--squash', 'fix/squashed-typo')
  git(repoRoot, 'commit', '-m', 'Fix a typo (squashed)')
  // Un second arbre fusionné, à nettoyer depuis sa conversation.
  const docs = join(data, 'external', 'nimbus-docs')
  git(repoRoot, 'worktree', 'add', '-b', 'docs/readme', docs, 'main')
  await writeFile(join(docs, 'NOTES.md'), 'notes\n')
  git(docs, 'add', '-A')
  git(docs, 'commit', '-m', 'Add notes')
  git(repoRoot, 'merge', '--no-ff', 'docs/readme', '-m', 'Merge docs/readme')
  const gone = join(data, 'external', 'nimbus-gone')
  git(repoRoot, 'worktree', 'add', '-b', 'feat/gone', gone, 'main')
  await rm(gone, { recursive: true, force: true })

  const docsSessionId = '00000000-0000-4000-8000-000000000046'
  const fixture = run(['--import', 'tsx', '--input-type=module', '-e', `
    import { randomUUID } from 'node:crypto'
    import { eq } from 'drizzle-orm'
    import { openDatabase, projects, worktrees, conversations } from '@sillage/db'
    import { loadConfig } from './src/config.ts'
    const { db, sqlite } = openDatabase(loadConfig().paths.database)
    const project = db.select().from(projects).where(eq(projects.name, 'Nimbus')).get()
    const source = db.select().from(conversations).where(eq(conversations.projectId, project.id)).get()
    const worktreeId = randomUUID()
    db.insert(worktrees).values({ id: worktreeId, projectId: project.id, name: 'docs/readme', path: ${JSON.stringify(docs)}, baseRef: 'main', createdBy: project.ownerId, createdAt: Date.now() }).run()
    db.insert(conversations).values({ ...source, id: ${JSON.stringify(docsSessionId)}, worktreeId, title: 'Document the forecast cache', status: 'idle', cardId: null, scheduleId: null, archivedAt: null }).run()
    sqlite.close()
  `], serverDir, env)
  const [fixtureCode] = await once(fixture, 'exit')
  assert.equal(fixtureCode, 0, fixture.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })

  const session = async (viewport, mobile) => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const status = await (await context.request.get(`${base}/api/projects/${project.id}/worktrees/status`)).json()
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    return { context, page, errors, project, status }
  }

  // L'API : quatre arbres, l'arbre principal exclu, chaque état représenté.
  const desktop = await session({ width: 1440, height: 900 }, false)
  const states = Object.fromEntries(desktop.status.worktrees.map((tree) => [tree.name, tree.state]))
  assert.deepEqual(states, {
    'docs/readme': 'merged',
    'feat/gone': 'missing',
    'feat/offline-cache': 'dirty',
    'feat/radar-prefetch': 'unmerged',
    'fix/squashed-typo': 'merged',
  })
  assert.equal(desktop.status.base, 'main')
  assert.ok(desktop.status.worktrees.find((tree) => tree.name === 'fix/squashed-typo').external)
  assert.ok(desktop.status.worktrees.find((tree) => tree.name === 'feat/offline-cache').conversations.length > 0)
  console.log('OK : états calculés sur la démo.')

  // Une fusion n'ajoute ni décision ni encombrement dans la barre latérale.
  const { page, errors, project } = desktop
  const decisions = await (await desktop.context.request.get(`${base}/api/decisions?status=pending&sources=worktree`)).json()
  assert.deepEqual(decisions.decisions, [])
  await page.goto(`${base}/p/${project.id}/c/${docsSessionId}`)
  const worktreeBar = (target) => target.getByRole('region', { name: 'Worktree de la conversation' })
  await worktreeBar(page).getByText('Fusionné dans main', { exact: true }).waitFor()
  assert.equal(await page.getByRole('region', { name: 'À décider' }).count(), 0)
  assert.ok((await worktreeBar(page).boundingBox()).height <= 44, 'Une seule barre compacte')
  await page.screenshot({ path: join(shots, 'conversation-merged-desktop.png') })
  const mergedPhone = await session({ width: 390, height: 844 }, true)
  await mergedPhone.page.goto(`${base}/p/${project.id}/c/${docsSessionId}`)
  await worktreeBar(mergedPhone.page).getByRole('button', { name: 'Nettoyer', exact: true }).waitFor()
  await mergedPhone.page.screenshot({ path: join(shots, 'conversation-merged-phone.png') })
  await mergedPhone.page.setViewportSize({ width: 320, height: 740 })
  assert.ok(await mergedPhone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await mergedPhone.page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await mergedPhone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  // Le geste au téléphone ouvre la même confirmation détaillée que la vue Chantiers.
  await worktreeBar(mergedPhone.page).getByRole('button', { name: 'Nettoyer', exact: true }).click()
  const phoneDialog = mergedPhone.page.getByRole('dialog', { name: 'Nettoyer docs/readme' })
  await phoneDialog.getByRole('switch', { name: 'Archiver 1 session' }).waitFor()
  await phoneDialog.getByRole('button', { name: 'Annuler', exact: true }).click()
  assert.ok(existsSync(docs), 'Annuler garde le worktree')
  await worktreeBar(page).getByRole('button', { name: 'Nettoyer', exact: true }).click()
  const cleanup = page.getByRole('dialog', { name: 'Nettoyer docs/readme' })
  await cleanup.getByText("Rien ici que la base n'ait déjà.", { exact: true }).waitFor()
  await cleanup.getByRole('button', { name: 'Nettoyer', exact: true }).click()
  await cleanup.waitFor({ state: 'hidden' })
  assert.ok(!existsSync(docs), 'Le dossier est retiré après confirmation')
  assert.equal(git(repoRoot, 'branch', '--list', 'docs/readme'), '')
  console.log('OK : worktree dans le fil, nettoyage confirmé, aucune décision automatique.')

  // Barre latérale : la session en worktree porte sa branche et son état, pas les autres.
  await page.goto(`${base}/p/${project.id}/board`)
  const nav = page.getByRole('navigation').filter({ has: page.getByRole('group', { name: 'Suivi des conversations' }) })
  // La ligne de session porte le titre en attribut ; le suivi d'activité, au-dessus, non.
  const row = (scope, title) => scope.locator(`a[title="${title}"]`)
  const offline = row(nav, 'Add offline caching for forecasts')
  await offline.waitFor()
  await offline.getByRole('note', { name: /Worktree feat\/offline-cache, Non commité/ }).waitFor()
  await row(nav, 'Radar tile prefetching').getByRole('note', { name: /À fusionner/ }).waitFor()
  // Une session de la racine ne dit rien de plus : seules les deux en worktree portent une note.
  assert.equal(await nav.getByRole('note').count(), 2)
  const chantiers = nav.getByRole('link', { name: /^Chantiers/ })
  await chantiers.waitFor()
  assert.match(await chantiers.innerText(), /3 en attente/)
  assert.match(await chantiers.innerText(), /1 à nettoyer/)
  await page.screenshot({ path: join(shots, 'sidebar-desktop.png') })
  console.log('OK : barre latérale sur grand écran.')

  // Le clic sur la pastille ouvre le fil et son onglet Git.
  await offline.getByRole('note').click()
  await page.waitForURL(/\/c\//)
  const panel = page.locator('[data-panel="workspace"]')
  await panel.getByText('feat/offline-cache', { exact: true }).first().waitFor()
  console.log('OK : la pastille ouvre l’onglet Git.')
  await worktreeBar(page).getByText('Non commité', { exact: true }).waitFor()
  assert.equal(await worktreeBar(page).getByRole('button', { name: 'Nettoyer', exact: true }).count(), 0)
  await worktreeBar(page).getByRole('button', { name: 'Voir le Git', exact: true }).waitFor()
  // La racine conserve sa branche dans l'en-tête, sans barre supplémentaire.
  const conversations = await (await desktop.context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
  const rootSession = conversations.find((entry) => !entry.worktreeId)
  await page.goto(`${base}/p/${project.id}/c/${rootSession.id}`)
  assert.equal(await worktreeBar(page).count(), 0)


  // Vue Chantiers sur la page projet, atteinte depuis la ligne de la barre latérale.
  await chantiers.click()
  await page.waitForURL(/#worktrees$/)
  const board = page.locator('#worktrees').locator('..')
  await board.getByRole('heading', { name: 'Chantiers' }).waitFor()
  const rows = board.locator('li', { has: page.locator('.font-mono') }).filter({ hasText: /^(feat|fix)\// })
  const names = await board.locator('li > div > div > span.font-mono').allInnerTexts()
  assert.deepEqual(names, ['feat/gone', 'feat/offline-cache', 'feat/radar-prefetch', 'fix/squashed-typo'], `ordre : ${names}`)
  await board.getByText('Créé hors de Sillage', { exact: true }).first().waitFor()
  await board.getByText('Introuvable', { exact: true }).first().waitFor()
  await board.getByRole('link', { name: 'Add offline caching for forecasts' }).waitFor()
  await board.getByRole('link', { name: /^Carte #\d+$/ }).first().waitFor()
  assert.ok((await rows.count()) >= 4)
  await board.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, 'board-desktop.png') })
  assert.deepEqual(errors, [])
  console.log('OK : vue Chantiers sur grand écran.')

  // Nettoyer l'arbre fusionné : la confirmation dit qu'il n'y a rien à perdre, propose
  // la branche, puis l'arbre et la branche disparaissent.
  const squashedRow = board.locator('li').filter({ has: page.locator('span.font-mono', { hasText: 'fix/squashed-typo' }) }).first()
  await squashedRow.getByRole('button', { name: 'Nettoyer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Nettoyer fix/squashed-typo' })
  await dialog.getByText("Rien ici que la base n'ait déjà.", { exact: true }).waitFor()
  await dialog.getByRole('switch', { name: 'Supprimer la branche fix/squashed-typo' }).waitFor()
  await page.screenshot({ path: join(shots, 'cleanup-dialog.png') })
  await dialog.getByRole('button', { name: 'Nettoyer', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator('span.font-mono', { hasText: 'fix/squashed-typo' }).waitFor({ state: 'detached' })
  assert.ok(!existsSync(squashed), 'Le dossier est retiré')
  assert.equal(git(repoRoot, 'branch', '--list', 'fix/squashed-typo'), '', 'La branche est supprimée')
  assert.match(await chantiers.innerText(), /3 en attente$/)
  console.log('OK : nettoyage en un geste.')

  // Un arbre non commité : la confirmation liste ce qui serait perdu, et la session à archiver.
  const offlineRow = board.locator('li').filter({ has: page.locator('span.font-mono', { hasText: 'feat/offline-cache' }) }).first()
  await offlineRow.getByRole('button', { name: 'Nettoyer', exact: true }).click()
  const dirtyDialog = page.getByRole('dialog', { name: 'Nettoyer feat/offline-cache' })
  await dirtyDialog.getByRole('alert').filter({ hasText: /fichiers modifiés/ }).waitFor()
  await dirtyDialog.getByRole('switch', { name: 'Archiver 1 session' }).waitFor()
  await dirtyDialog.getByRole('switch', { name: /Passer la carte #\d+ en Terminé/ }).waitFor()
  await page.screenshot({ path: join(shots, 'cleanup-dialog-dirty.png') })
  await dirtyDialog.getByRole('button', { name: 'Annuler', exact: true }).click()
  await dirtyDialog.waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  console.log('OK : confirmation sur un arbre non commité.')

  // Téléphone : la ligne reste lisible, la vue ne déborde pas.
  const phone = await session({ width: 390, height: 844 }, true)
  await phone.page.goto(`${base}/p/${project.id}/board`)
  await phone.page.getByRole('button', { name: 'Ouvrir la navigation', exact: true }).click()
  const phoneNav = phone.page.getByRole('navigation').filter({ has: phone.page.getByRole('group', { name: 'Suivi des conversations' }) })
  const phoneTag = row(phoneNav, 'Add offline caching for forecasts').getByRole('note')
  await phoneTag.waitFor()
  // Le tiroir glisse : la capture attend qu'il soit en place.
  await delay(600)
  const tagBox = await phoneTag.boundingBox()
  assert.ok(tagBox && tagBox.width > 0, 'La pastille est visible au téléphone')
  assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.page.screenshot({ path: join(shots, 'sidebar-phone.png') })
  await phoneNav.getByRole('link', { name: /^Chantiers/ }).click()
  await phone.page.waitForURL(/#worktrees$/)
  await phone.page.getByRole('heading', { name: 'Chantiers' }).waitFor()
  await phone.page.locator('#worktrees').scrollIntoViewIfNeeded()
  await delay(600)
  assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Pas de défilement horizontal au téléphone')
  await phone.page.screenshot({ path: join(shots, 'board-phone.png') })
  assert.deepEqual(phone.errors, [])
  console.log('OK : barre latérale et vue Chantiers au téléphone.')
  const offlineConversation = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
  await phone.page.goto(`${base}/p/${project.id}/c/${offlineConversation.id}`)
  await worktreeBar(phone.page).getByText('Non commité', { exact: true }).waitFor()
  await phone.page.screenshot({ path: join(shots, 'conversation-dirty-phone.png') })
  assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

  // En Desktop, même origine pour le web et l'API : Vite serait refusé par le WebSocket.
  const desktopWeb = join(data, 'desktop-web')
  const build = run([join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', desktopWeb], webDir, { ...env, NODE_ENV: 'production' })
  const [buildCode] = await once(build, 'exit')
  assert.equal(buildCode, 0, build.diagnostics)
  // Même code en Desktop, avec la session du lanceur et sans page de connexion.
  server.kill('SIGTERM')
  await once(server, 'exit')
  const deskServer = run(['--import', 'tsx', 'src/main.ts'], serverDir, {
    ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3', SILLAGE_WEB_ROOT: desktopWeb,
  }, ['pipe', 'pipe', 'pipe', 'pipe'])
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    deskServer.stdio[3].on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('\n')) resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
    })
    deskServer.once('exit', () => reject(new Error(deskServer.diagnostics)))
  })
  const deskBase = `http://127.0.0.1:${handshake.port}`
  const deskContext = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await deskContext.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await deskContext.addCookies([{ name: 'sillage_session', value: handshake.session, url: deskBase }])
  const deskPage = await deskContext.newPage()
  await deskPage.goto(`${deskBase}/p/${project.id}/c/${offlineConversation.id}`)
  await worktreeBar(deskPage).getByText('Non commité', { exact: true }).waitFor()
  const instance = await (await deskContext.request.get(`${deskBase}/api/system/instance`)).json()
  assert.equal(instance.profile, 'desktop')
  await deskPage.screenshot({ path: join(shots, 'conversation-desktop-edition.png') })
  const english = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US', serviceWorkers: 'block' })
  await english.addCookies([{ name: 'sillage_session', value: handshake.session, url: deskBase }])
  await english.addInitScript(() => { localStorage.setItem('sillage.locale', 'en'); localStorage.setItem('sillage.theme', 'dark') })
  const englishPage = await english.newPage()
  await englishPage.goto(`${deskBase}/p/${project.id}/c/${offlineConversation.id}`)
  await englishPage.getByRole('region', { name: 'Conversation worktree' }).getByText('Uncommitted', { exact: true }).waitFor()
  await englishPage.getByText('Connected', { exact: true }).waitFor()
  await englishPage.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await englishPage.screenshot({ path: join(shots, 'conversation-dark-english.png') })
  console.log('OK : barre contextuelle dans l’édition Desktop.')
} finally {
  await browser?.close()
  await Promise.all(processes.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const stopped = once(child, 'exit')
    child.stdin?.end()
    child.kill('SIGTERM')
    await Promise.race([stopped, delay(2000)])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await stopped
    }
  }))
  await rm(data, { recursive: true, force: true })
}
