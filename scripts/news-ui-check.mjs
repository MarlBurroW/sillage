import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// API et composants réels sur une base jetable ; les flux sont des fixtures en cache.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const data = await mkdtemp('/var/tmp/sillage-news-ui-')
const children = []
let browser
async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}
function run(args, env, handshake = false) {
  const child = spawn(process.execPath, args, { cwd: serverDir, env, stdio: handshake ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe' })
  child.diagnostics = ''
  children.push(child)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-8000) })
  return child
}
async function ready(origin, child) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw Error(child.diagnostics)
    if (await fetch(`${origin}/api/health`).then((r) => r.ok).catch(() => false)) return
    await delay(100)
  }
  throw Error(child.diagnostics)
}
try {
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n')
  const port = await freePort()
  const env = { ...process.env, NODE_ENV: 'development', TMPDIR: '/var/tmp', SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'server'), SILLAGE_WEB_ROOT: join(root, 'apps/web/dist'), GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.test', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.test' }
  const origin = `http://127.0.0.1:${port}`
  const server = run(['--import', 'tsx', 'src/main.ts'], env)
  await ready(origin, server)
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)
  const fixture = run(['--import', 'tsx', '--input-type=module', '-e', `
    import {openDatabase,newsFeeds,users} from '@sillage/db';
    import {writeNewsPreferences} from './src/settings/user-settings.ts';
    const {db,sqlite}=openDatabase(process.env.SILLAGE_DATA_DIR+'/sillage.db');
    const user=db.select().from(users).all().find(u=>u.username==='alex');
    const articles=['Un modèle ouvert pour les développeurs','Un nouvel outil pour tester les agents','Des données publiques pour la recherche'].map((title,i)=>({title,url:'https://example.org/article-'+i,source:'Veille de test',publishedAt:Date.now()-i*1000}));
    for(const url of ['https://example.org/rss','https://example.org/atom']) db.insert(newsFeeds).values({url,data:JSON.stringify({title:'Veille de test',articles,fetchedAt:Date.now()}),checkedAt:Date.now()}).run();
    writeNewsPreferences(db,user.id,{enabled:true,sources:[{url:'https://example.org/rss',enabled:true}]});sqlite.close();
  `], env)
  assert.equal((await once(fixture, 'exit'))[0], 0, fixture.diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    assert.ok((await context.request.post(`${origin}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${origin}/settings/veille`)
    await page.getByRole('heading', { name: 'Articles récents' }).waitFor()
    const toggle = page.getByRole('switch', { name: 'Afficher la veille pendant les tours', exact: true })
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'false')
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true')
    await page.getByLabel('Ajouter un flux RSS ou Atom').fill('https://example.org/atom')
    await page.getByRole('button', { name: 'Tester le flux', exact: true }).click()
    await page.locator('[data-news-preview]').waitFor()
    await page.getByRole('button', { name: 'Ajouter la source', exact: true }).click()
    await page.getByText('https://example.org/atom', { exact: true }).waitFor()
    await page.screenshot({ path: `/var/tmp/sillage-news-settings-${width}.png`, fullPage: true })
    // Retirer la source ajoutée garde le scénario rejouable sur la taille suivante.
    await page.getByRole('button', { name: 'Retirer Veille de test', exact: true }).last().click()
    await page.getByText('https://example.org/atom', { exact: true }).waitFor({ state: 'detached' })
    const projects = await (await context.request.get(`${origin}/api/projects`)).json()
    const project = projects.find((p) => p.name === 'Nimbus')
    const sessions = await (await context.request.get(`${origin}/api/projects/${project.id}/conversations`)).json()
    const hero = sessions.find((s) => s.title === 'Add offline caching for forecasts')
    await page.clock.install()
    await page.goto(`${origin}/p/${project.id}/c/${hero.id}`)
    const ticker = page.locator('[data-news-ticker]')
    await ticker.waitFor()
    await ticker.scrollIntoViewIfNeeded()
    const headline = ticker.locator('[data-news-headline]')
    await page.mouse.move(0, 0)
    const first = await headline.innerText()
    await page.clock.fastForward(12500)
    const second = await headline.innerText()
    assert.notEqual(second, first, 'rotation automatique')
    await page.clock.fastForward(12000)
    const third = await headline.innerText()
    assert.notEqual(third, first)
    assert.notEqual(third, second, 'parcourir les articles avant de boucler')
    await page.clock.fastForward(12000)
    assert.equal(await headline.innerText(), first)
    if (width > 600) {
      await headline.hover()
      await page.clock.fastForward(25000)
      assert.equal(await headline.innerText(), first, 'pause au survol')
      await page.mouse.move(0, 0)
    }
    await ticker.getByRole('button', { name: 'Mettre la veille en pause' }).click()
    const paused = await headline.innerText()
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.activeElement?.blur())
    await page.clock.fastForward(25000)
    assert.equal(await headline.innerText(), paused, 'pause explicite')
    await ticker.getByRole('button', { name: 'Article suivant' }).click()
    assert.notEqual(await headline.innerText(), paused, 'article suivant')
    await ticker.getByRole('button', { name: 'Reprendre la veille' }).click()
    await page.keyboard.press('Tab')
    await headline.focus()
    const focused = await headline.innerText()
    await page.clock.fastForward(25000)
    assert.equal(await headline.innerText(), focused, 'pause au focus')
    await page.clock.fastForward(300)
    await page.screenshot({ path: `/var/tmp/sillage-news-ticker-${width}.png` })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await ticker.getByRole('button', { name: 'Masquer pour ce tour' }).click()
    await ticker.waitFor({ state: 'detached' })
    assert.deepEqual(errors, [])
    await context.close()
  }
  const deskPort = await freePort()
  const desktop = run(['--import', 'tsx', 'src/main.ts'], { ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3', SILLAGE_PORT: String(deskPort), SILLAGE_DATA_DIR: join(data, 'desktop') }, true)
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    desktop.stdio[3].on('data', (chunk) => { buffer += chunk; if (buffer.includes('\n')) resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))) })
    desktop.once('exit', () => reject(Error(desktop.diagnostics)))
  })
  const deskOrigin = `http://127.0.0.1:${handshake.port}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addCookies([{ name: 'sillage_session', value: handshake.session, url: deskOrigin }])
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const settings = await (await context.request.get(`${deskOrigin}/api/me/settings`)).json()
  await context.request.patch(`${deskOrigin}/api/me/settings`, { data: { onboarding: { ...settings.onboarding, pending: false } } })
  const page = await context.newPage()
  await page.goto(`${deskOrigin}/settings/veille`)
  await page.getByRole('switch', { name: 'Afficher la veille pendant les tours' }).waitFor()
  assert.equal(await page.getByRole('switch', { name: 'Afficher la veille pendant les tours' }).getAttribute('aria-checked'), 'false')
  await page.screenshot({ path: '/var/tmp/sillage-news-desktop.png' })
  await context.close()
  console.log('News UI: Server desktop/mobile, rotation, pause, focus, sources, and Desktop profile passed.')
} finally {
  await browser?.close()
  for (const child of children.reverse()) if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]) }
  await rm(data, { recursive: true, force: true })
}
