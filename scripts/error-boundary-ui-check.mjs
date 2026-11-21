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

// Render failures stay contained: a broken thread element, a broken page, a lazy chunk a
// deployment removed. Real server and Vite on a disposable demo database; failures are injected
// by rewriting responses, as a newer server or a missing build file would produce them.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-error-boundary-check-'))
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
    const conversations = await (await context.request.get(`${base}/api/conversations`)).json()
    const conversation = conversations.find((entry) => entry.projectId === project.id)
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    return { context, page, errors, project, conversation }
  }

  // 1. One thread element whose payload cannot be drawn: the rest of the thread and the composer stay.
  const desk = await session({ width: 1440, height: 900 }, false)
  const url = `${base}/p/${desk.project.id}/c/${desk.conversation.id}`
  await desk.page.route(`**/api/conversations/${desk.conversation.id}/thread*`, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    // A tool call whose name is not the text its view expects, as a CLI update could send it.
    const target = body.state?.items?.find((item) => item.kind === 'tool')
    if (target) target.name = 42
    await route.fulfill({ response, json: body })
  })
  await desk.page.goto(url)
  await desk.page.getByText("Cet élément n'a pas pu s'afficher.", { exact: true }).first().waitFor()
  await desk.page.screenshot({ path: join(data, 'item-crash-desktop.png') })
  await desk.page.locator('textarea').first().waitFor()
  assert.ok(await desk.page.locator('[data-seq]').count() > 0, 'other messages still render')
  console.log('OK : un élément du fil qui casse devient un encart, le reste du fil et le composer restent.')
  await desk.page.unroute(`**/api/conversations/${desk.conversation.id}/thread*`)

  // 2. A conversation from a newer server naming a CLI this tab does not know: the page fails, the shell stays.
  await desk.page.route(`**/api/conversations/${desk.conversation.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), agent: 'future-cli' } })
  })
  await desk.page.goto(url)
  await desk.page.getByText("Cette page n'a pas pu s'afficher", { exact: true }).waitFor()
  await desk.page.getByRole('button', { name: 'Réessayer', exact: true }).waitFor()
  await desk.page.screenshot({ path: join(data, 'page-crash-desktop.png') })
  // Leaving the page clears the error without a reload.
  await desk.page.locator(`a[href="/p/${desk.project.id}/board"]`).first().click()
  await desk.page.getByText("Cette page n'a pas pu s'afficher", { exact: true }).waitFor({ state: 'hidden' })
  console.log('OK : une page qui casse garde la navigation, et la quitter efface l’erreur.')
  await desk.page.unroute(`**/api/conversations/${desk.conversation.id}`)

  // 3. A lazy chunk gone after a deployment: one reload, then the page error instead of a blank page.
  let loads = 0
  desk.page.on('load', () => { loads += 1 })
  await desk.page.route(/\/src\/routes\/WallPage\.tsx/, (route) => route.abort())
  await desk.page.goto(`${base}/wall`)
  await desk.page.getByText("Cette page n'a pas pu s'afficher", { exact: true }).waitFor()
  await delay(1000)
  assert.equal(loads, 2, 'exactly one automatic reload, then no loop')
  console.log('OK : un chunk introuvable recharge une fois, puis affiche l’erreur au lieu d’une page blanche.')
  assert.deepEqual(desk.errors, [], 'no uncaught page error')

  // 4. Phone: the page error fits 390 px.
  const phone = await session({ width: 390, height: 844 }, true)
  await phone.page.route(`**/api/conversations/${phone.conversation.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), agent: 'future-cli' } })
  })
  await phone.page.goto(`${base}/p/${phone.project.id}/c/${phone.conversation.id}`)
  const crash = phone.page.getByText("Cette page n'a pas pu s'afficher", { exact: true })
  await crash.waitFor()
  const fits = await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  assert.ok(fits, 'no horizontal scroll on the phone')
  await phone.page.screenshot({ path: join(data, 'page-crash-phone.png') })
  // The broken page drew the phone's menu button: the way out must lead to a working page. Home
  // would redirect to this same conversation once it is remembered as the last one.
  await phone.page.getByRole('button', { name: 'Quitter cette page', exact: true }).click()
  await crash.waitFor({ state: 'hidden' })
  await phone.page.waitForURL(`**/p/${phone.project.id}/board`)
  assert.deepEqual(phone.errors, [])
  console.log('OK : erreurs contenues sur grand écran et au téléphone.')
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  await delay(200)
  if (process.env.KEEP_CHECK_DATA) console.log(`Données gardées : ${data}`)
  else await rm(data, { recursive: true, force: true })
}
