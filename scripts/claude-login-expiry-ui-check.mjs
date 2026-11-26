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

// Real HTTP, cookies, notification WebSocket, providers and hooks; only the CLI is a fixture.
// Desktop needs apps/web/dist, Server runs Vite to exercise its origin-preserving proxy.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const scratch = await mkdtemp(join(tmpdir(), 'sillage-host-expiry-ui-'))
const children = []
let browser

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function run(args, cwd, env, stdio = 'pipe') {
  const child = spawn(process.execPath, args, { cwd, env, stdio })
  children.push(child)
  child.diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
  return child
}

async function ready(url, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(child.diagnostics)
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return
    await delay(100)
  }
  throw new Error(`Fixture did not start: ${child.diagnostics}`)
}

async function check(profile) {
  const desktop = profile === 'desktop'
  const dir = join(scratch, profile)
  await mkdir(dir)
  const apiPort = await freePort()
  const webPort = await freePort()
  const statusFile = join(dir, 'status.json')
  const binary = join(dir, 'claude-fixture.mjs')
  const setDate = async (days) => {
    const date = new Date(Date.now() + days * 86_400_000).toISOString()
    await writeFile(statusFile, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: date }))
    return date
  }
  const initialDate = await setDate(9)
  await writeFile(binary, `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
if (process.argv.includes('--version')) console.log('2.1.325 (Claude Code)')
else if (process.argv.slice(2).join(' ') === 'auth status') process.stdout.write(readFileSync(process.env.SILLAGE_FIXTURE_AUTH_STATUS))
`, { mode: 0o700 })
  const config = join(dir, 'config.toml')
  await writeFile(config, `[agents.claude]\nbinary = ${JSON.stringify(binary)}\n` + ['codex', 'opencode', 'grok', 'antigravity'].map((kind) => `[agents.${kind}]\nenabled = false\n`).join(''))
  const env = {
    ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1',
    SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(dir, 'data'), SILLAGE_PROFILE: profile,
    SILLAGE_WEB_ROOT: desktop ? join(webDir, 'dist') : join(dir, 'web'),
    CLAUDE_CONFIG_DIR: join(dir, 'empty-claude-home'), SILLAGE_FIXTURE_AUTH_STATUS: statusFile,
    ...(desktop ? { SILLAGE_HANDSHAKE_FD: '3' } : {}),
  }
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  const [seedCode] = await once(seed, 'exit')
  assert.equal(seedCode, 0, seed.diagnostics)
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env, desktop ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe')
  const handshake = desktop ? new Promise((resolve, reject) => {
    let received = ''
    server.stdio[3].on('data', (chunk) => {
      received += chunk
      if (received.includes('\n')) resolve(JSON.parse(received.split('\n')[0]))
    })
    server.once('exit', () => reject(new Error(server.diagnostics)))
  }) : null
  const base = `http://127.0.0.1:${desktop ? apiPort : webPort}`
  const vite = desktop ? null : run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ...(vite ? [ready(base, vite)] : [])])
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  if (desktop) await context.addCookies([{ name: 'sillage_session', value: (await handshake).session, url: base }])
  else assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const status = await context.request.get(`${base}/api/claude-accounts/host-login`)
  assert.equal(status.status(), 200, await status.text())
  assert.deepEqual(Object.keys(await status.json()).sort(), ['checkedAt', 'loginExpiresAt', 'state'])
  assert.equal((await status.json()).loginExpiresAt, initialDate)

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/settings/comptes-claude`)
  await page.getByRole('heading', { name: 'Connexion du CLI hôte', exact: true }).waitFor()
  await page.getByText('Renouvelle la connexion avant que', { exact: false }).waitFor()
  await page.locator('[data-nav-space="activity"]').click()
  const activity = page.locator('[data-nav-activity]')
  await activity.getByRole('link', { name: /Connexion Claude à renouveler/ }).waitFor()
  await activity.getByRole('link', { name: /Connexion Claude à renouveler/ }).click()
  await page.getByRole('button', { name: 'Connecter un compte personnel', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Nouveau compte', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('textbox', { name: 'Nom', exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  // A new native expiry causes a real server notification, delivered over /api/ws.
  await setDate(2)
  await page.getByRole('button', { name: 'Revérifier la connexion de l’hôte', exact: true }).click()
  await page.getByText('Renouvelle la connexion maintenant', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Voir les comptes Claude', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Voir les comptes Claude', exact: true }).click()
  if (process.env.SHOTS) {
    await mkdir(process.env.SHOTS, { recursive: true })
    await page.screenshot({ path: join(process.env.SHOTS, `${profile}-host-expiry-wide.png`), animations: 'disabled' })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('button', { name: 'Connecter un compte personnel', exact: true }).click()
  await dialog.waitFor()
  const box = await dialog.boundingBox()
  assert.ok(box.width <= 390 && box.x >= 0, 'the account flow must fit a phone')
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).click()
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${profile}-host-expiry-phone.png`), animations: 'disabled' })

  // Reconnecting updates the date and removes the persistent Activity warning.
  await setDate(30)
  await page.getByRole('button', { name: 'Revérifier la connexion de l’hôte', exact: true }).click()
  await page.getByText('Renouvelle la connexion maintenant', { exact: false }).waitFor({ state: 'hidden' })
  // The label gains "· Mise à jour disponible" whenever GitHub has a newer release than this build.
  await page.getByRole('button', { name: /^Ouvrir la navigation/ }).click()
  await page.locator('[data-nav-space="activity"]').click()
  await activity.waitFor()
  assert.equal(await activity.getByRole('link', { name: /Connexion Claude à renouveler/ }).count(), 0)
  assert.deepEqual(errors, [])
  await context.close()
  console.log(`OK ${profile}: actual CLI fixture, admin status, Activity, notification WebSocket, account dialog, renewal, 1440px and 390px.`)
}

try {
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  await check('server')
  await check('desktop')
} finally {
  await browser?.close()
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await stopped
    clearTimeout(timer)
  }))
  await rm(scratch, { recursive: true, force: true })
}
