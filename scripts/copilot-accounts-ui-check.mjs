import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Extra GitHub Copilot accounts on both editions: creation in a dialog, device-code sign-in,
// the account choice in CLI defaults and on the new-session screen, a conversation launched on
// the account's home without the server's GitHub tokens, sign-out, phone width. Real components
// and API, temporary database; the CLI is the test fake (`apps/server/test/fixtures/copilot-agent.mjs`),
// speaking like Copilot CLI 1.0.116 without contacting GitHub.
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
  const binary = join(data, 'copilot.mjs')
  await copyFile(join(serverDir, 'test/fixtures/copilot-agent.mjs'), binary)
  await chmod(binary, 0o700)
  const config = join(data, 'config.toml')
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok', 'antigravity'].map((agent) => `[agents.${agent}]\nenabled = false\n`).join('') + `[agents.copilot]\nbinary = "${binary}"\n`)
  browser = await chromium.launch({ chromiumSandbox: true })
  const errors = []

  for (const profile of ['server', 'desktop']) {
    const port = await freePort()
    // The machine's own Copilot home, which account homes link into.
    const userHome = join(data, `user-copilot-${profile}`)
    await mkdir(join(userHome, 'skills'), { recursive: true })
    await writeFile(join(userHome, 'settings.json'), '{"model":"auto"}')
    const env = {
      ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_PROFILE: profile,
      SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, profile), SILLAGE_WEB_ROOT: join(webDir, 'dist'),
      COPILOT_HOME: userHome,
      // Tokens the server holds for the GitHub CLI: an account's session must not see them.
      GH_TOKEN: 'gh-cli-token-for-check', COPILOT_GITHUB_TOKEN: 'machine-token-for-check',
      // Slow enough for the screen to show the code before GitHub "confirms".
      FIXTURE_LOGIN_DELAY: '4000',
      ...(profile === 'desktop' ? { SILLAGE_HANDSHAKE_FD: '3' } : {}),
    }
    const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env, profile === 'desktop' ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe')
    const handshake = profile === 'desktop' ? new Promise((resolve, reject) => {
      let buffer = ''
      server.stdio[3].on('data', (chunk) => { buffer += chunk; if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0])) })
      server.once('exit', () => reject(new Error(server.diagnostics)))
    }) : null
    const base = `http://127.0.0.1:${port}`
    await ready(base + '/api/health', server)
    const signIn = async (context) => {
      await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
      if (handshake) {
        await context.addCookies([{ name: 'sillage_session', value: (await handshake).session, url: base }])
      } else {
        assert.ok((await context.request.post(base + '/api/auth/login', { data: { username: 'alex', password: 'sillage-demo' } })).ok())
      }
    }
    if (!handshake) {
      const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
      const [code] = await once(seed, 'exit')
      assert.equal(code, 0, seed.diagnostics)
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
    await signIn(context)
    const json = async (response) => { assert.ok(response.ok(), await response.text()); return response.json() }
    await context.request.patch(base + '/api/me/settings', { data: { onboarding: { completedAt: Date.now(), pending: false } } })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => errors.push(error.message))
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)

    // 1. The settings entry leads to the page; the account is named in a dialog.
    await page.goto(base + '/settings')
    await page.getByRole('link', { name: /Comptes Copilot/ }).first().click()
    await page.waitForURL(/\/settings\/comptes-copilot$/)
    await page.getByText('Aucun compte supplémentaire').waitFor()
    await page.getByRole('button', { name: 'Ajouter un compte' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Nom').fill('Boulot')
    await dialog.getByRole('button', { name: 'Créer le compte' }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByText('Non connecté').waitFor()
    const [created] = (await json(await context.request.get(base + '/api/copilot-accounts'))).accounts
    assert.equal(created.status, 'pending')
    const accountHome = join(data, profile, 'copilot-accounts', created.id)

    // 2. Device code: the code Copilot printed, then the GitHub login once it "confirms".
    await page.getByRole('button', { name: "Se connecter par code d'appareil" }).click()
    await page.getByText('Ouvrir github.com/login/device').waitFor()
    assert.equal(await page.locator('code').first().textContent(), 'B2E9-F9F7')
    assert.equal(await page.getByRole('link', { name: /github.com\/login\/device/ }).getAttribute('href'), 'https://github.com/login/device')
    await page.screenshot({ path: `/var/tmp/sillage-copilot-accounts-${profile}-device.png` })
    await page.getByText('Connecté', { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByText('GitHub · octo-fixture').waitFor()
    assert.ok((await lstat(join(accountHome, 'session-state'))).isSymbolicLink(), "sessions are the machine home's")
    assert.equal(JSON.parse(await readFile(join(accountHome, 'settings.json'), 'utf8')).storeTokenPlaintext, true)
    assert.ok(await fits())
    await page.screenshot({ path: `/var/tmp/sillage-copilot-accounts-${profile}-ready.png` })

    // 3. The account choice appears in Copilot's defaults.
    await page.goto(base + '/settings/cli')
    await page.getByRole('radio', { name: /GitHub Copilot/ }).click()
    const account = page.getByRole('combobox', { name: 'Compte', exact: true })
    await account.click()
    await page.getByRole('option', { name: 'Boulot' }).click()
    await delay(500)
    assert.equal((await json(await context.request.get(base + '/api/me/settings'))).agentDefaults.copilot.account, created.id)

    // 4. The new-session screen offers it too, with the budget it has not read yet.
    let project
    if (profile === 'server') {
      project = (await json(await context.request.get(base + '/api/projects'))).find((entry) => entry.name === 'Nimbus')
    } else {
      const workspacePath = join(data, 'desktop-workspace')
      await mkdir(workspacePath, { recursive: true })
      project = await json(await context.request.post(base + '/api/projects', { data: { name: 'Bureau', workspacePath, visibility: 'private' } }))
    }
    await page.goto(base + `/p/${project.id}/c/new?agent=copilot`)
    await page.getByRole('radio', { name: /Boulot/ }).waitFor()
    await page.getByText('Budget affiché après son premier tour').first().waitFor()
    await page.screenshot({ path: `/var/tmp/sillage-copilot-accounts-${profile}-draft.png` })

    // 5. A conversation on the account runs in its home, without the server's tokens.
    const agentConfig = { agent: 'copilot', model: 'auto', reasoningEffort: '', autoTier: '', mode: 'agent', allowAll: 'off', additionalDirectories: [], mcpServers: [], sillageMcp: false, skillLibrary: false, account: created.id }
    const conversation = await json(await context.request.post(base + `/api/projects/${project.id}/conversations`, { data: { agent: 'copilot', config: agentConfig, title: 'Copilot account check', firstMessage: { clientMessageId: randomUUID(), text: 'hello' } } }))
    await page.goto(base + `/p/${project.id}/c/${conversation.id}`)
    let launch = null
    for (let i = 0; i < 100 && launch?.home !== accountHome; i++) {
      launch = JSON.parse(await readFile(join(data, 'launch.json'), 'utf8').catch(() => 'null'))
      if (launch?.home !== accountHome) await delay(100)
    }
    assert.equal(launch?.home, accountHome, 'the session runs in the account home')
    assert.deepEqual(launch.tokens, [], "the server's GitHub tokens are withheld")

    // 6. Signing out forgets the home's sign-in.
    await page.goto(base + '/settings/comptes-copilot')
    await page.getByRole('button', { name: 'Déconnecter ce compte' }).click()
    await page.getByText('Non connecté').waitFor()
    assert.equal(await readFile(join(accountHome, 'config.json'), 'utf8').catch(() => null), null)

    // 7. Phone width.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR', serviceWorkers: 'block' })
    await signIn(mobile)
    const phone = await mobile.newPage()
    phone.on('pageerror', (error) => errors.push(error.message))
    await phone.goto(base + '/settings/comptes-copilot')
    await phone.getByText('Boulot', { exact: true }).waitFor()
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await phone.screenshot({ path: `/var/tmp/sillage-copilot-accounts-${profile}-mobile.png` })
    await mobile.close()
    await context.close()
  }

  assert.deepEqual(errors, [])
  console.log('OK: settings entry, dialog, device code, CLI defaults, new-session choice, account home without tokens, sign-out, phone, Server and Desktop.')
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
