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
const shots = join(root, 'docs/audits/2026-10-17-worktrees')
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
  // Un second arbre fusionné, que « À décider » proposera de nettoyer.
  const docs = join(data, 'external', 'nimbus-docs')
  git(repoRoot, 'worktree', 'add', '-b', 'docs/readme', docs, 'main')
  await writeFile(join(docs, 'NOTES.md'), 'notes\n')
  git(docs, 'add', '-A')
  git(docs, 'commit', '-m', 'Add notes')
  git(repoRoot, 'merge', '--no-ff', 'docs/readme', '-m', 'Merge docs/readme')
  const gone = join(data, 'external', 'nimbus-gone')
  git(repoRoot, 'worktree', 'add', '-b', 'feat/gone', gone, 'main')
  await rm(gone, { recursive: true, force: true })

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

  // « À décider » : le calcul a proposé de nettoyer les deux arbres fusionnés. La
  // réponse « Nettoyer » retire l'arbre et sa branche, sans passer par une session.
  const { page, errors, project } = desktop
  await page.goto(`${base}/p/${project.id}/board`)
  const decided = page.getByRole('region', { name: 'À décider' })
  await decided.getByRole('button', { name: /docs\/readme est fusionnée et propre : nettoyer \?/ }).click()
  const decisionDialog = page.getByRole('dialog', { name: 'docs/readme est fusionnée et propre : nettoyer ?' })
  await decisionDialog.getByText("Rien dans cet arbre que la branche par défaut n'ait déjà.").waitFor()
  assert.equal(await decisionDialog.getByRole('textbox').count(), 0, 'Pas de note à écrire : aucune session ne la lirait')
  await decisionDialog.getByRole('radio', { name: 'Nettoyer' }).click()
  await page.screenshot({ path: join(shots, 'decision-dialog.png') })
  await decisionDialog.getByRole('button', { name: 'Envoyer' }).click()
  await decisionDialog.getByText('Répondu par', { exact: false }).waitFor()
  assert.ok(!existsSync(docs), 'Le dossier est retiré par la réponse')
  assert.equal(git(repoRoot, 'branch', '--list', 'docs/readme'), '', 'La branche est supprimée par la réponse')
  await page.screenshot({ path: join(shots, 'decision-answered.png') })
  await page.keyboard.press('Escape')
  await decisionDialog.waitFor({ state: 'hidden' })
  console.log('OK : « À décider » propose et nettoie un arbre fusionné.')

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
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await delay(200)
  await rm(data, { recursive: true, force: true })
}
