import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Retours sur le board (20 oct. 2026) : références `#n` cliquables avec aperçu au
// survol, `#` du composer, tiroir refermé d'un clic à côté, carte saisie par tout son
// corps, ordre par arrivée dans la colonne. Vrais composants, vraie API, base temporaire.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-ui-check-'))
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

/** Glisse au pointeur, depuis le centre d'un élément jusqu'à un autre. */
async function drag(page, from, to) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 })
  await page.mouse.move(b.x + b.width / 2, b.y + 60, { steps: 15 })
  await delay(150)
  await page.mouse.up()
}

try {
  const apiPort = await freePort()
  const webPort = await freePort()
  const env = {
    ...process.env,
    SILLAGE_PORT: String(apiPort),
    SILLAGE_HOST: '127.0.0.1',
    SILLAGE_DATA_DIR: join(data, 'data'),
    SILLAGE_WEB_ROOT: join(data, 'web'),
  }
  delete env.NODE_ENV
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const projects = await (await context.request.get(`${base}/api/projects`)).json()
  const project = projects.find((entry) => entry.name === 'Nimbus')
  const conversations = await (await context.request.get(`${base}/api/conversations`)).json()
  const radar = conversations.find((entry) => entry.title === 'Radar tile prefetching')
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // 1. Les `#n` d'une réponse : liés quand la carte existe, texte sinon.
  await page.goto(`${base}/p/${project.id}/c/${radar.id}`)
  const ref4 = page.locator('button.sg-card-ref[data-sg-card="4"]')
  await ref4.waitFor()
  await page.locator('button.sg-card-ref[data-sg-card="10"]').waitFor()
  assert.equal(await page.locator('[data-sg-card="42"]').count(), 0, '#42 n’existe pas : il reste du texte')
  await page.getByText('the old #42 idea is gone').waitFor()
  await ref4.hover()
  const tooltip = page.getByRole('tooltip').filter({ hasText: 'Radar map performance' })
  await tooltip.waitFor()
  await tooltip.getByText(/À vérifier|À relire/).waitFor()
  await page.screenshot({ path: '/tmp/sillage-bf-ref-preview.png' })
  await page.mouse.move(5, 500)
  await tooltip.waitFor({ state: 'detached' })

  // 2. Le `#` du composer propose les cartes et écrit le numéro.
  const composer = page.getByPlaceholder(/Écris ton message/)
  await composer.click()
  await composer.pressSequentially('voir #rad')
  const picker = page.getByRole('listbox', { name: /carte/i })
  await picker.getByRole('option', { name: /Radar map performance/ }).waitFor()
  await page.screenshot({ path: '/tmp/sillage-bf-composer-picker.png' })
  await page.keyboard.press('Enter')
  assert.equal(await composer.inputValue(), 'voir #4 ')
  await composer.fill('')

  // 3. Le clic sur une référence ouvre la carte dans le board.
  await page.locator('button.sg-card-ref[data-sg-card="10"]').click()
  await page.waitForURL(/\/board\?carte=10$/)
  const panel = page.getByRole('complementary', { name: /#10/ })
  await panel.getByRole('heading', { name: 'City list virtualization' }).waitFor()
  // La description cite #2 : lien et aperçu dans le tiroir aussi.
  const ref2 = panel.locator('button.sg-card-ref[data-sg-card="2"]')
  await ref2.hover()
  await page.getByRole('tooltip').filter({ hasText: 'Offline caching for forecasts' }).waitFor()
  await page.screenshot({ path: '/tmp/sillage-bf-panel-ref.png' })
  await page.mouse.move(5, 500)

  // 4. Un clic dans le vide du board referme le tiroir ; un clic sur une carte bascule.
  const todo = page.getByRole('region', { name: 'À faire' }).or(page.locator('section[aria-label="À faire"]')).first()
  await page.locator('[data-card-tile="1"] [data-card-open]').click()
  await page.waitForURL(/carte=1$/)
  const progress = page.locator('section[aria-label="En cours"]')
  const box = await progress.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 30)
  await page.waitForURL((url) => !url.search.includes('carte'))
  await page.getByRole('complementary', { name: /#1/ }).waitFor({ state: 'hidden' })

  // 5. La carte se saisit par son corps, sans viser la poignée, et le geste n'ouvre rien.
  await drag(page, page.locator('[data-card-tile="1"]'), progress)
  await progress.locator('[data-card-tile="1"]').waitFor()
  await delay(500)
  assert.ok(!page.url().includes('carte'), 'glisser n’ouvre pas la carte')
  const cards = await (await context.request.get(`${base}/api/projects/${project.id}/cards`)).json()
  assert.equal(cards.find((card) => card.number === 1).column, 'in_progress')
  await page.screenshot({ path: '/tmp/sillage-bf-drag.png' })
  assert.ok(todo)

  // 6. L'ordre par arrivée : #1 vient d'arriver en cours, #2 y est depuis la veille.
  const tiles = () => progress.locator('[data-card-tile]').evaluateAll((nodes) => nodes.map((node) => node.dataset.cardTile))
  await page.getByRole('button', { name: 'Ordre des cartes' }).click()
  await page.getByRole('menuitem', { name: 'Arrivées récentes en tête' }).click()
  await page.waitForFunction(() => document.querySelector('section[aria-label="En cours"] [data-card-tile]')?.getAttribute('data-card-tile') === '1')
  assert.deepEqual(await tiles(), ['1', '2'])
  await progress.getByText(/il y a|maintenant|à l’instant/).first().waitFor()
  await page.screenshot({ path: '/tmp/sillage-bf-order-recent.png' })
  await page.getByRole('button', { name: 'Ordre des cartes' }).click()
  await page.getByRole('menuitem', { name: 'Arrivées anciennes en tête' }).click()
  await page.waitForFunction(() => document.querySelector('section[aria-label="En cours"] [data-card-tile]')?.getAttribute('data-card-tile') === '2')
  const settings = await (await context.request.get(`${base}/api/me/settings`)).json()
  assert.equal(settings.boardOrder[project.id], 'oldest')
  await page.reload()
  await page.waitForFunction(() => document.querySelector('section[aria-label="En cours"] [data-card-tile]')?.getAttribute('data-card-tile') === '2')

  // Au téléphone : le board tient dans la largeur, les références s'ouvrent au doigt.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
  await mobile.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await mobile.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })
  const phone = await mobile.newPage()
  await phone.goto(`${base}/p/${project.id}/board`)
  await phone.locator('[data-card-tile]').first().waitFor()
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await phone.screenshot({ path: '/tmp/sillage-bf-mobile-board.png' })
  await phone.goto(`${base}/p/${project.id}/c/${radar.id}`)
  await phone.locator('button.sg-card-ref[data-sg-card="4"]').tap()
  await phone.waitForURL(/\/board\?carte=4$/)
  await phone.screenshot({ path: '/tmp/sillage-bf-mobile-card.png' })
  await mobile.close()

  assert.deepEqual(errors, [])
  console.log('OK : références de cartes et aperçu, # du composer, tiroir refermé à côté, glisser par la carte, ordre par arrivée, mobile.')
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
