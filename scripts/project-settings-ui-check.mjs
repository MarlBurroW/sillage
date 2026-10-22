import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { checkAppearance } from './appearance-navigation-flow.mjs'
import { checkSchedule } from './schedule-navigation-flow.mjs'
import { checkSettingsMenu } from './settings-menu-flow.mjs'

// Run against disposable Server and Desktop databases, with real hooks and persistence.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const data = await mkdtemp('/var/tmp/sillage-project-settings-')
const shots = process.env.PROJECT_SETTINGS_SHOTS ?? '/var/tmp/sillage-project-settings-shots'
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
async function ok(response) { assert.ok(response.ok(), `${response.status()} ${await response.text()}`); return response }
async function skipTour(context, origin) {
  const settings = await (await context.request.get(`${origin}/api/me/settings`)).json()
  await ok(await context.request.patch(`${origin}/api/me/settings`, { data: { onboarding: { ...settings.onboarding, pending: false } } }))
}
async function fixture(context, origin, id) {
  await ok(await context.request.patch(`${origin}/api/projects/${id}`, { data: { memoryMode: 'sillage', instructionsMode: 'sillage' } }))
  for (let i = 0; i < 29; i++) await ok(await context.request.put(`${origin}/api/projects/${id}/memory/note-${String(i).padStart(2, '0')}.md`, {
    data: { content: `---\nname: Note ${i}\ndescription: Décision de conception ${i}\ntype: project\n---\n${i === 28 ? 'Éléphant unique dans le contenu.' : 'Une note de travail.'}` },
  }))
}
async function check(context, origin, project, width, profile) {
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(15000)
  const url = `${origin}/p/${project.id}`
  await page.goto(url)
  const nav = page.getByRole('navigation', { name: 'Réglages du projet', exact: true })
  const go = async (name) => {
    await nav.getByRole('link', { name, exact: true }).click()
    await nav.getByRole('link', { name, exact: true }).and(page.locator('[aria-current=page]')).waitFor()
  }
  await page.getByLabel('Nom', { exact: true }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Visibilité', exact: true }).count(), profile === 'desktop' ? 0 : 1)
  assert.ok((await page.getByLabel('Nom', { exact: true }).boundingBox()).y < 500)
  await page.getByLabel('Nom', { exact: true }).fill('Brouillon conservé')
  await go('Consignes')
  const instructions = page.getByRole('region', { name: 'Consignes', exact: true }).locator('textarea')
  await instructions.fill('Consigne non enregistrée')
  await go('Mémoire')
  const memory = page.getByRole('region', { name: 'Mémoire', exact: true })
  await memory.locator('[data-memory-file]').first().waitFor()
  assert.equal(await memory.locator('[data-memory-file]').count(), 12)
  await memory.getByRole('button', { name: 'Suivant', exact: true }).click()
  await memory.getByRole('status').filter({ hasText: 'Page 2' }).waitFor()
  await page.getByLabel('Rechercher une note').fill('elephant')
  await memory.locator('[data-memory-file="note-28.md"]').waitFor()
  assert.equal(await memory.locator('[data-memory-file]').count(), 1)
  await memory.locator('[data-memory-file="note-28.md"]').click()
  await memory.locator('textarea:visible').fill('Brouillon mémoire')
  await go('Général')
  assert.equal(await page.getByLabel('Nom', { exact: true }).inputValue(), 'Brouillon conservé')
  await go('Consignes')
  assert.equal(await instructions.inputValue(), 'Consigne non enregistrée')
  await go('Mémoire')
  assert.equal(await memory.locator('textarea:visible').inputValue(), 'Brouillon mémoire')
  await memory.getByRole('button', { name: 'Retour aux notes' }).click()
  assert.equal(await page.getByLabel('Rechercher une note').inputValue(), 'elephant')
  await page.getByLabel('Rechercher une note').fill('note-00')
  await memory.locator('[data-memory-file="note-00.md"]').click()
  await memory.getByRole('button', { name: 'Retour aux notes' }).click()
  await page.getByLabel('Rechercher une note').fill('elephant')
  await memory.locator('[data-memory-file="note-28.md"]').click()
  assert.equal(await memory.locator('textarea:visible').inputValue(), 'Brouillon mémoire')
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/memory/note-28.md') && r.request().method() === 'PUT'), memory.getByRole('button', { name: 'Enregistrer', exact: true }).click()])
  const stored = await (await context.request.get(`${origin}/api/projects/${project.id}/memory`)).json()
  assert.equal(stored.files.find((f) => f.file === 'note-28.md').content, 'Brouillon mémoire')
  await memory.getByRole('button', { name: 'Retour aux notes' }).click()
  await page.getByLabel('Rechercher une note').fill('no-such-note')
  await page.getByText('Aucune note ne correspond à la recherche.').waitFor()
  await page.getByLabel('Rechercher une note').fill('')
  await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${width}-memory.png`) })
  await go('Skills')
  await go('Agents')
  await go('Général')
  await page.goBack()
  await nav.getByRole('link', { name: 'Agents', exact: true }).and(page.locator('[aria-current=page]')).waitFor()
  await page.goForward()
  await nav.getByRole('link', { name: 'Général', exact: true }).and(page.locator('[aria-current=page]')).waitFor()
  await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${width}-general.png`) })
  // The category bar remains reachable even at the bottom of the active section.
  await page.getByRole('region', { name: 'Général', exact: true }).evaluate((el) => { el.scrollTop = el.scrollHeight })
  assert.ok((await nav.boundingBox()).y >= 0)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  const outer = await page.locator('main').evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }))
  assert.ok(outer.scroll <= outer.height + 1, JSON.stringify(outer))
  await page.goto(`${url}#worktrees`)
  if (project.git) {
    await nav.getByRole('link', { name: 'Worktrees', exact: true }).and(page.locator('[aria-current=page]')).waitFor()
    await page.screenshot({ animations: 'disabled', path: join(shots, `${profile}-${width}-worktrees.png`) })
  }
  await page.goto(`${url}?section=memory`)
  await page.getByLabel('Rechercher une note').waitFor()
  await page.reload()
  await page.getByLabel('Rechercher une note').waitFor()
  assert.deepEqual(errors, [])
  await page.close()
}
try {
  await mkdir(shots, { recursive: true })
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n')
  const port = await freePort()
  const env = { ...process.env, NODE_ENV: 'development', TMPDIR: '/var/tmp', SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'server'), SILLAGE_WEB_ROOT: join(root, 'apps/web/dist'), GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.test', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.test' }
  const origin = `http://127.0.0.1:${port}`
  const server = run(['--import', 'tsx', 'src/main.ts'], env)
  await ready(origin, server)
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, isMobile: width < 600, hasTouch: width < 600, locale: 'fr-FR', serviceWorkers: 'block' })
    await ok(await context.request.post(`${origin}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } }))
    await skipTour(context, origin)
    const projects = await (await context.request.get(`${origin}/api/projects`)).json()
    const project = projects.find((p) => p.name === 'Nimbus')
    await fixture(context, origin, project.id)
    await checkSettingsMenu(context, origin, width, 'server', shots)
    await check(context, origin, project, width, 'server')
    await checkAppearance(context, origin, width, 'server', shots)
    await checkSchedule(context, origin, project, width, 'server', shots)
    await context.close()
  }
  const owner = await browser.newContext({ serviceWorkers: 'block' })
  await ok(await owner.request.post(`${origin}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } }))
  const shared = (await (await owner.request.get(`${origin}/api/projects`)).json()).find((p) => p.name === 'Nimbus')
  await ok(await owner.request.patch(`${origin}/api/projects/${shared.id}`, { data: { visibility: 'shared' } }))
  await ok(await owner.request.post(`${origin}/api/users`, { data: { username: 'reader', displayName: 'Reader', password: 'sillage-demo-reader', isAdmin: false } }))
  const reader = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  await reader.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  await ok(await reader.request.post(`${origin}/api/auth/login`, { data: { username: 'reader', password: 'sillage-demo-reader' } }))
  await skipTour(reader, origin)
  const readPage = await reader.newPage()
  await readPage.goto(`${origin}/p/${shared.id}?section=agents`)
  const readNav = readPage.getByRole('navigation', { name: 'Réglages du projet' })
  await readNav.waitFor()
  assert.equal(await readNav.getByRole('link', { name: 'Agents', exact: true }).count(), 0)
  assert.equal(await readPage.getByLabel('Nom', { exact: true }).count(), 0)
  await readNav.getByRole('link', { name: 'Mémoire', exact: true }).click()
  await readPage.getByLabel('Rechercher une note').fill('note-00')
  await readPage.locator('[data-memory-file="note-00.md"]').click()
  await readPage.getByRole('heading', { name: 'note-00.md' }).waitFor()
  assert.equal(await readPage.locator('textarea:visible').count(), 0)
  assert.equal(await readPage.getByRole('button', { name: 'Enregistrer', exact: true }).count(), 0)
  await checkSettingsMenu(reader, origin, 390, 'server', shots, false)
  await reader.close()
  await owner.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  const deletePage = await owner.newPage()
  await deletePage.goto(`${origin}/p/${shared.id}?section=memory`)
  await deletePage.getByLabel('Rechercher une note').fill('note-27')
  await deletePage.getByRole('button', { name: 'Supprimer note-27.md ?', exact: true }).click()
  const confirm = deletePage.getByRole('alertdialog').or(deletePage.getByRole('dialog'))
  await confirm.getByRole('button', { name: 'Supprimer la note', exact: true }).click()
  await deletePage.getByText('Aucune note ne correspond à la recherche.').waitFor()
  await owner.close()
  const deskPort = await freePort()
  const desktop = run(['--import', 'tsx', 'src/main.ts'], { ...env, SILLAGE_PROFILE: 'desktop', SILLAGE_HANDSHAKE_FD: '3', SILLAGE_PORT: String(deskPort), SILLAGE_DATA_DIR: join(data, 'desktop') }, true)
  const handshake = await new Promise((resolve, reject) => {
    let buffer = ''
    desktop.stdio[3].on('data', (chunk) => { buffer += chunk; if (buffer.includes('\n')) resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n')))) })
    desktop.once('exit', () => reject(Error(desktop.diagnostics)))
  })
  const deskOrigin = `http://127.0.0.1:${handshake.port}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addCookies([{ name: 'sillage_session', value: handshake.session, url: deskOrigin }])
  await skipTour(context, deskOrigin)
  const response = await ok(await context.request.post(`${deskOrigin}/api/projects`, { data: { name: 'Desktop project', workspacePath: join(data, 'server/demo/nimbus'), visibility: 'private' } }))
  const project = await response.json()
  await fixture(context, deskOrigin, project.id)
  await checkSettingsMenu(context, deskOrigin, 1280, 'desktop', shots)
  await check(context, deskOrigin, project, 1280, 'desktop')
  await checkAppearance(context, deskOrigin, 1280, 'desktop', shots)
  await checkSchedule(context, deskOrigin, project, 1280, 'desktop', shots)
  await context.close()
  console.log('Automation navigation, drafts, bench actions, failed-save retry and persistence passed; Schedule tabs, drafts, validation, script trial, persistence and webhook creation passed; Appearance categories and persistence passed; project settings UI passed: Server desktop/mobile, Desktop profile, read-only member, deletion, deep links, history, drafts, memory pagination/search/save, fixed navigation.')
} finally {
  await browser?.close()
  for (const child of children.reverse()) if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]) }
  if (process.env.PROJECT_SETTINGS_KEEP) console.log(`Disposable data kept: ${data}`)
  else await rm(data, { recursive: true, force: true })
}
