import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// L'onglet Git sur la démo : vrai serveur, vrai git, base temporaire. Le worktree du
// chantier « offline cache » porte des changements non commités : c'est le terrain.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-git-check-'))
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
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = {
    ...process.env,
    // Le dépôt de démo n'a pas d'identité : git prend celle de l'environnement.
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

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })

  const session = async (viewport, mobile) => {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    const login = await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
    assert.ok(login.ok())
    const projects = await (await context.request.get(`${base}/api/projects`)).json()
    const project = projects.find((entry) => entry.name === 'Nimbus')
    const conversations = await (await context.request.get(`${base}/api/projects/${project.id}/conversations`)).json()
    const hero = conversations.find((entry) => entry.title === 'Add offline caching for forecasts')
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${base}/p/${project.id}/c/${hero.id}`)
    return { context, page, errors, hero }
  }

  // Grand écran : le workflow complet.
  const { page, errors, hero } = await session({ width: 1440, height: 900 }, false)
  await page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
  const panel = page.locator('[data-panel="workspace"]')
  await panel.getByRole('button', { name: 'Git', exact: true }).click()

  // L'en-tête dit la branche du worktree, pas celle du projet.
  await panel.getByText('feat/offline-cache', { exact: true }).first().waitFor()
  const stagedGroup = panel.getByText('Dans l’index', { exact: true })
  const unstagedGroup = panel.getByText('Hors de l’index', { exact: true })
  await unstagedGroup.waitFor()
  assert.equal(await stagedGroup.count(), 0, 'Rien dans l’index au départ')

  // Ajouter un fichier à l'index depuis sa ligne.
  const firstRow = panel.locator('.group\\/change').first()
  const firstPath = await firstRow.getAttribute('data-path')
  await firstRow.hover()
  await firstRow.getByRole('button', { name: 'Ajouter à l’index', exact: true }).click()
  await stagedGroup.waitFor()
  await panel.getByText('1 fichier dans l’index', { exact: true }).waitFor()
  console.log(`OK : ${firstPath} ajouté à l’index.`)

  // Le diff d'un fichier se déplie à la demande.
  const stagedRow = panel.locator(`.group\\/change[data-path="${firstPath}"]`).first()
  await stagedRow.getByRole('button').first().click()
  await panel.locator('table').first().waitFor()

  // Commiter ce qui est dans l'index, au clavier.
  const message = panel.getByRole('textbox', { name: 'Message du commit', exact: true })
  await message.fill('Vérifier le commit depuis Sillage\n\nDeuxième paragraphe conservé tel quel.')
  await message.press('Control+Enter')
  await panel.getByText(/^Commit [0-9a-f]{7,} créé\.$/).waitFor()
  await panel.getByText('Vérifier le commit depuis Sillage', { exact: true }).first().waitFor()
  assert.equal(await message.inputValue(), '', 'Le message est vidé après le commit')
  assert.equal(await stagedGroup.count(), 0, 'L’index est vide après le commit')
  console.log('OK : commit créé et listé.')

  // Branches : la courante, celle du projet prise par un autre worktree, et une neuve.
  await panel.getByRole('button', { name: /^Branches/ }).click()
  const currentRow = panel.locator('.group\\/branch').filter({ hasText: 'feat/offline-cache' }).first()
  await currentRow.getByText('courante', { exact: true }).waitFor()
  const mainRow = panel.locator('.group\\/branch').filter({ hasText: 'main' }).first()
  await mainRow.getByText('dans un worktree', { exact: true }).waitFor()
  await mainRow.hover()
  assert.equal(await mainRow.getByRole('button', { name: 'Passer sur main', exact: true }).isDisabled(), true, 'Une branche d’un autre worktree ne se change pas ici')

  await panel.getByRole('button', { name: 'Nouvelle branche', exact: true }).click()
  await panel.getByRole('textbox', { name: 'Nom de la branche', exact: true }).fill('ui/check')
  await panel.getByRole('button', { name: 'Créer', exact: true }).click()
  await panel.locator('.group\\/branch').filter({ hasText: 'ui/check' }).getByText('courante', { exact: true }).waitFor()
  console.log('OK : branche créée et extraite.')

  // Retour, puis suppression de la branche neuve.
  await currentRow.hover()
  await currentRow.getByRole('button', { name: 'Passer sur feat/offline-cache', exact: true }).click()
  await currentRow.getByText('courante', { exact: true }).waitFor()
  const checkRow = panel.locator('.group\\/branch').filter({ hasText: 'ui/check' }).first()
  await checkRow.hover()
  await checkRow.getByRole('button', { name: 'Actions pour ui/check', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Supprimer la branche', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer la branche', exact: true }).click()
  await checkRow.waitFor({ state: 'hidden' })
  console.log('OK : branche supprimée après confirmation.')

  // Stash des changements restants, puis pop.
  await panel.getByRole('button', { name: 'Stasher les changements', exact: true }).click()
  await panel.getByRole('textbox', { name: 'Message (facultatif)', exact: true }).fill('Mis de côté par la vérification')
  await panel.getByRole('button', { name: 'Stasher', exact: true }).click()
  const stashRow = panel.locator('.group\\/stash').first()
  await stashRow.getByText('Mis de côté par la vérification', { exact: true }).waitFor()
  await panel.getByText('Rien à commiter, le répertoire de travail est propre.', { exact: true }).waitFor()
  await stashRow.hover()
  await stashRow.getByRole('button', { name: 'Pop : appliquer et retirer', exact: true }).click()
  await panel.getByText('Aucun stash.', { exact: true }).waitFor()
  await unstagedGroup.waitFor()
  console.log('OK : stash puis pop, les changements sont revenus.')

  // Les références des commits : la branche courante est posée sur le commit de tête.
  await panel.locator('[title="feat/offline-cache"]').first().waitFor()
  await page.screenshot({ path: '/tmp/sillage-git-desktop.png' })
  assert.deepEqual(errors, [])

  // Le dépôt a bien bougé sur le disque : le commit existe dans l'API des commits.
  const commits = await (await page.context().request.get(`${base}/api/conversations/${hero.id}/commits?limit=5`)).json()
  assert.equal(commits.commits[0].subject, 'Vérifier le commit depuis Sillage')

  // Téléphone : tout tient dans 390 px, les actions restent accessibles sans survol.
  const phone = await session({ width: 390, height: 844 }, true)
  await phone.page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
  const mobilePanel = phone.page.locator('[data-panel="workspace"]')
  await mobilePanel.getByRole('button', { name: 'Git', exact: true }).click()
  await mobilePanel.getByText('feat/offline-cache', { exact: true }).first().waitFor()
  await mobilePanel.getByRole('button', { name: 'Tout ajouter et commiter', exact: true }).waitFor()
  const stage = mobilePanel.getByRole('button', { name: 'Ajouter à l’index', exact: true }).first()
  const box = await stage.boundingBox()
  assert.ok(box && box.height >= 44, `Cible tactile de ${box?.height} px`)
  const width = await mobilePanel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
  assert.ok(width, 'Pas de défilement horizontal au téléphone')
  await phone.page.screenshot({ path: '/tmp/sillage-git-phone.png' })
  assert.deepEqual(phone.errors, [])

  console.log('OK : onglet Git vérifié sur grand écran et au téléphone.')
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await delay(200)
  await rm(data, { recursive: true, force: true })
}
