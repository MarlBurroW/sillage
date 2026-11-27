import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Settings › OpenCode providers: connected providers listed (an environment variable included),
// a provider picked in a window and connected with a typed key that goes out once, then
// disconnected after confirmation. Disposable database and servers; the provider routes are
// mocked, so no OpenCode starts.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const require = createRequire(join(serverDir, 'package.json'))
const data = await mkdtemp(join(tmpdir(), 'sillage-opencode-providers-ui-'))
const shots = join(root, '.artifacts')
const children = []
let browser

async function port() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const number = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return number
}

function run(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'pipe' })
  children.push(child)
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
  throw new Error(`Service did not start: ${child.diagnostics}`)
}

try {
  const [apiPort, webPort] = await Promise.all([port(), port()])
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n')
  const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: join(data, 'web') }
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)

  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])

  browser = await chromium.launch()
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const phone = viewport.width < 600
    const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block', hasTouch: phone, isMobile: phone })
    let credentials = []
    const requests = []
    const providers = () => [
      { id: 'vertex', name: 'Vertex', acceptsKey: false, connections: [{ type: 'env', name: 'GOOGLE_CLOUD_PROJECT' }] },
      { id: 'anthropic', name: 'Anthropic', acceptsKey: true, connections: credentials },
      { id: 'openrouter', name: 'OpenRouter', acceptsKey: true, connections: [] },
    ]
    await context.route('**/api/opencode/providers', (route) => route.fulfill({ json: { providers: providers() } }))
    await context.route('**/api/opencode/providers/*/key', (route) => {
      requests.push([route.request().method(), new URL(route.request().url()).pathname, route.request().postDataJSON()])
      credentials = [{ type: 'credential', id: 'cred_1', label: 'Travail', method: 'key' }]
      return route.fulfill({ status: 204 })
    })
    await context.route('**/api/opencode/credentials/*', (route) => {
      requests.push([route.request().method(), new URL(route.request().url()).pathname, null])
      credentials = []
      return route.fulfill({ status: 204 })
    })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())

    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${base}/settings/fournisseurs-opencode`)
    await page.getByRole('heading', { name: 'Fournisseurs OpenCode' }).first().waitFor()
    // The environment variable counts as a connection, without a disconnect button.
    await page.getByText('GOOGLE_CLOUD_PROJECT').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Déconnecter' }).count(), 0)

    await page.getByRole('button', { name: 'Connecter un fournisseur' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    // Only providers taking a key, filtered by the search.
    assert.equal(await dialog.getByRole('option', { name: /Vertex/ }).count(), 0)
    await dialog.getByLabel('Fournisseur').first().fill('anth')
    assert.equal(await dialog.getByRole('option').count(), 1)
    await dialog.getByRole('option', { name: /Anthropic/ }).click()
    await dialog.getByLabel('Clé API Anthropic').fill('sk-ant-typed')
    await dialog.getByLabel('Nom').fill('Travail')
    await page.screenshot({ path: join(shots, `opencode-providers-connect-${phone ? 'phone' : 'desktop'}.png`) })
    await dialog.getByRole('button', { name: 'Connecter', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(requests.shift(), ['POST', '/api/opencode/providers/anthropic/key', { key: 'sk-ant-typed', label: 'Travail' }])

    await page.getByText('Travail', { exact: true }).waitFor()
    // The key never comes back to the page.
    assert.equal((await page.content()).includes('sk-ant-typed'), false)
    await page.screenshot({ path: join(shots, `opencode-providers-${phone ? 'phone' : 'desktop'}.png`), fullPage: true })

    await page.getByRole('button', { name: 'Déconnecter' }).click()
    await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Déconnecter' }).click()
    await page.getByText('Travail', { exact: true }).waitFor({ state: 'detached' })
    assert.deepEqual(requests.shift(), ['DELETE', '/api/opencode/credentials/cred_1', null])
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('OpenCode providers UI check passed')
} finally {
  await browser?.close()
  for (const child of children) child.kill()
  await rm(data, { recursive: true, force: true })
}
