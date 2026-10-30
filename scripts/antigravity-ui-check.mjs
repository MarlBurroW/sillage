import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Google account, composer, native wire, fork and handoff journeys on both editions.
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
  const binary = join(data, 'antigravity.mjs')
  await copyFile(join(serverDir, 'test/fixtures/antigravity-agent.mjs'), binary)
  await chmod(binary, 0o700)
  const config = join(data, 'config.toml')
  // Claude stays enabled: the server now refuses handoffs to a disabled CLI, and the transfer below only creates a conversation.
  await writeFile(config, ['codex', 'opencode', 'grok'].map((agent) => `[agents.${agent}]\nenabled = false\n`).join('') + `[agents.antigravity]\nbinary = "${binary}"\n`)
  browser = await chromium.launch({ chromiumSandbox: true })
  const errors = []
  for (const profile of ['server', 'desktop']) {
    const port = await freePort()
    const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_PROFILE: profile, SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, profile), SILLAGE_WEB_ROOT: join(webDir, 'dist'), GEMINI_HOME: join(data, 'native-home'), ...(profile === 'desktop' ? { SILLAGE_HANDSHAKE_FD: '3' } : {}) }
    await mkdir(env.GEMINI_HOME, { recursive: true })
    const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env, profile === 'desktop' ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe')
    const handshake = profile === 'desktop' ? new Promise((resolve, reject) => {
      let buffer = ''
      server.stdio[3].on('data', (chunk) => { buffer += chunk; if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0])) })
      server.once('exit', () => reject(new Error(server.diagnostics)))
    }) : null
    const base = `http://127.0.0.1:${port}`
    await ready(base + '/api/health', server)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    if (handshake) {
      const result = await handshake
      await context.addCookies([{ name: 'sillage_session', value: result.session, url: base }])
    } else {
      const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
      const [code] = await once(seed, 'exit')
      assert.equal(code, 0, seed.diagnostics)
      assert.ok((await context.request.post(base + '/api/auth/login', { data: { username: 'alex', password: 'sillage-demo' } })).ok())
    }
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('pageerror', (error) => errors.push(error.message))
    // Complete the tour through its API to focus this check on the integration.
    await context.request.patch(base + '/api/me/settings', { data: { onboarding: { completedAt: Date.now() } } })
    await page.goto(base + '/settings/comptes-antigravity')
    if (page.url().endsWith('/bienvenue')) {
      await page.getByRole('button', { name: 'Passer la visite' }).click()
      await page.goto(base + '/settings/comptes-antigravity')
    }
    await page.getByRole('button', { name: 'Ajouter un compte' }).first().click()
    await page.getByLabel('Nom', { exact: true }).fill('Google perso')
    await page.getByRole('button', { name: 'Créer le compte' }).click()
    await page.getByLabel('Mode de connexion').selectOption('gemini-api-key')
    await page.getByLabel('Clé API Gemini', { exact: true }).fill('test-key-never-real')
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
    await page.getByText('Configuré', { exact: true }).waitFor()
    assert.ok(!(await page.content()).includes('test-key-never-real'))
    const accounts = await (await context.request.get(base + '/api/antigravity-accounts')).json()
    const id = accounts.accounts[0].id
    const modelsResponse = await context.request.get(base + `/api/agents/antigravity/models?account=${id}`)
    assert.ok(modelsResponse.ok(), await modelsResponse.text())
    assert.equal((await modelsResponse.json()).models[1].efforts.length, 2)
    await page.screenshot({ path: `/var/tmp/sillage-antigravity-${profile}-accounts.png` })

    await page.goto(base + '/settings/cli')
    await page.getByRole('radio', { name: /Google Antigravity/ }).click()
    await page.getByRole('combobox', { name: 'Compte', exact: true }).click()
    await page.getByRole('option', { name: 'Google perso' }).click()
    await delay(500)
    const settings = await (await context.request.get(base + '/api/me/settings')).json()
    assert.equal(settings.agentDefaults.antigravity.account, id)
    await page.getByRole('combobox', { name: 'Modèle', exact: true }).click()
    await page.getByRole('option', { name: /Gemini Fast/ }).click()
    await page.screenshot({ path: `/var/tmp/sillage-antigravity-${profile}-composer.png` })

    const agentConfig = { agent: 'antigravity', model: 'gemini-test', reasoningEffort: 'low', permissionMode: 'default', account: id, sillageMcp: true, skillLibrary: true }
    if (profile === 'server') {
      const projects = await (await context.request.get(base + '/api/projects')).json()
      const project = projects.find((entry) => entry.name === 'Nimbus')
      // Adopt an existing native history through the draft's actual import control.
      const nativeId = randomUUID()
      const accountsRoot = join(env.SILLAGE_DATA_DIR, 'antigravity-accounts', id)
      await writeFile(join(accountsRoot, 'antigravity-acp', 'conversations', nativeId + '.db'), 'native-fixture')
      await writeFile(join(data, 'sessions.json'), JSON.stringify([{ sessionId: nativeId, cwd: project.workspacePath, title: 'Imported Google session' }]))
      await writeFile(join(data, 'history.json'), JSON.stringify([
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'An external CLI request' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Imported native answer' } },
      ]))
      await page.goto(base + `/p/${project.id}/c/new?agent=antigravity`)
      await page.getByText(/reprendre une session.*Antigravity/).click()
      await page.getByRole('button', { name: /Imported Google session/ }).click()
      await page.getByText('Imported native answer', { exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Compacter le contexte' }).count(), 0)
      await delay(400) // Let the conversation's reveal animation settle for the screenshot.
      await page.screenshot({ path: `/var/tmp/sillage-antigravity-${profile}-import.png` })
      await rm(join(data, 'sessions.json'))
      // The reverse transfer starts from a populated Claude history, without inference.
      const seeded = await (await context.request.get(base + `/api/projects/${project.id}/conversations`)).json()
      const claudeSource = seeded.find((entry) => entry.agent === 'claude' && entry.lastSeq > 2)
      assert.ok(claudeSource)
      const inbound = await context.request.post(base + `/api/conversations/${claudeSource.id}/handoff`, { data: { agent: 'antigravity', config: agentConfig } })
      assert.ok(inbound.ok(), await inbound.text())
      const inboundSession = await inbound.json()
      assert.equal(inboundSession.handoffFromId, claudeSource.id)
      const inboundHistory = await (await context.request.get(base + `/api/conversations/${inboundSession.id}/handoff`)).json()
      assert.ok(inboundHistory.text.length > 50)
      const text = 'fixture:' + JSON.stringify({ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Native Antigravity response' } } }] })
      const response = await context.request.post(base + `/api/projects/${project.id}/conversations`, { data: { agent: 'antigravity', config: agentConfig, title: 'Google integration check', firstMessage: { clientMessageId: randomUUID(), text } } })
      assert.ok(response.ok(), await response.text())
      const conversation = await response.json()
      await page.goto(base + `/p/${project.id}/c/${conversation.id}`)
      await page.getByText('Native Antigravity response', { exact: true }).waitFor()
      await page.getByText('Native Antigravity response', { exact: true }).waitFor()
      // Model catalogues and command discovery reject another user's account IDs.
      assert.equal((await context.request.get(base + `/api/agents/antigravity/models?account=${randomUUID()}`)).status(), 404)
      const latest = await (await context.request.get(base + `/api/conversations/${conversation.id}`)).json()
      const futureText = 'fixture:' + JSON.stringify({ steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Future native response' } } }] })
      assert.ok((await context.request.post(base + `/api/conversations/${conversation.id}/messages`, { data: { clientMessageId: randomUUID(), text: futureText } })).ok())
      await page.getByText('Future native response', { exact: true }).first().waitFor()
      const forkResponse = await context.request.post(base + `/api/conversations/${conversation.id}/fork`, { data: { throughSeq: latest.lastSeq } })
      assert.ok(forkResponse.ok(), await forkResponse.text())
      const fork = await forkResponse.json()
      assert.equal(fork.forkedFromId, conversation.id)
      const history = await (await context.request.get(base + `/api/conversations/${fork.id}/handoff`)).json()
      assert.ok(history.text.includes('Native Antigravity response'))
      assert.ok(!history.text.includes('Future native response'), 'Forks must stop at the selected turn')
      const resumed = await context.request.post(base + `/api/conversations/${fork.id}/messages`, { data: { clientMessageId: randomUUID(), text: '/usage' } })
      assert.ok(resumed.ok(), await resumed.text())
      const transfer = await context.request.post(base + `/api/conversations/${conversation.id}/handoff`, { data: { agent: 'claude', config: settings.agentDefaults.claude } })
      assert.ok(transfer.ok(), await transfer.text())
      const other = await transfer.json()
      const back = await context.request.post(base + `/api/conversations/${other.id}/handoff`, { data: { agent: 'antigravity', config: agentConfig } })
      // A continuation with no own messages has no transferable journal yet.
      assert.equal(back.status(), 400)
      const rpc = (await readFile(join(data, 'rpc.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
      assert.equal(rpc.some((entry) => entry.method === 'session/fork'), false)
      assert.ok(rpc.some((entry) => entry.method === 'session/new' && entry.params._meta?.antigravity?.systemPrompt?.append.includes('Native Antigravity response')))
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(base + `/p/${project.id}/c/${conversation.id}`)
      await page.getByText('Future native response', { exact: true }).first().waitFor()
      await delay(400)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: '/var/tmp/sillage-antigravity-server-phone-conversation.png' })
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(base + '/settings/comptes-antigravity')
    await page.getByText('Google perso', { exact: true }).waitFor()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: `/var/tmp/sillage-antigravity-${profile}-mobile.png` })
    await page.getByRole('button', { name: 'Déconnecter ce compte' }).click()
    await page.getByText('Non connecté').waitFor()
    assert.equal((await (await context.request.get(base + '/api/antigravity-accounts')).json()).accounts[0].status, 'pending')
    await context.close()
    console.log(`OK: Antigravity ${profile}, accounts, model/effort selection and phone layout`)
  }
  assert.deepEqual(errors, [])
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

