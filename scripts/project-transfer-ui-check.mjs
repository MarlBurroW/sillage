import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { conversations, openDatabase } from '../packages/db/src/index.ts'
import { defaultConfigFor } from '../packages/protocol/src/index.ts'
import { EventLog } from '../apps/server/src/events/event-log.ts'

// Run with node --import ./apps/server/node_modules/tsx/dist/loader.mjs.
// Real Server/Desktop APIs and journals; all CLIs disabled, no native agent or credentials used.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const data = await mkdtemp(join(tmpdir(), 'sillage-transfer-ui-'))
const shots = process.env.TRANSFER_SHOTS ?? join(data, 'shots')
const children = []
let browser
async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}
function run(args, cwd, env, handshake = false) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: handshake ? ['pipe', 'pipe', 'pipe', 'pipe'] : 'pipe' })
  child.diagnostics = ''
  children.push(child)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.diagnostics = (child.diagnostics + chunk).slice(-8000) })
  return child
}
async function ready(url, child) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw Error(child.diagnostics)
    if (await fetch(url).then(r => r.ok).catch(() => false)) return
    await delay(100)
  }
  throw Error(child.diagnostics)
}
async function json(response) {
  assert.ok(response.ok(), response.status() + ' ' + await response.text())
  return response.json()
}
try {
  await mkdir(shots, { recursive: true })
  const config = join(data, 'config.toml')
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok', 'antigravity'].map(agent => '[agents.' + agent + ']\nenabled = false\n').join(''))
  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  for (const profile of (process.env.TRANSFER_PROFILE ? [process.env.TRANSFER_PROFILE] : ['server', 'desktop'])) {
    const apiPort = await freePort()
    const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PROFILE: profile, SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, profile), SILLAGE_WEB_ROOT: join(root, 'apps/web/dist') }
    if (profile === 'desktop') env.SILLAGE_HANDSHAKE_FD = '3'
    else delete env.SILLAGE_HANDSHAKE_FD
    const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env, profile === 'desktop')
    const handshake = profile === 'desktop' ? new Promise((resolve, reject) => {
      let output = ''
      server.stdio[3].on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])) })
      server.once('exit', () => reject(Error(server.diagnostics)))
    }) : null
    const origin = 'http://127.0.0.1:' + apiPort
    await ready(origin + '/api/health', server)
    const desk = handshake ? await handshake : null
    let serverStorage
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, isMobile: width < 600, locale: 'fr-FR', serviceWorkers: 'block', ...(serverStorage ? { storageState: serverStorage } : {}) })
      await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
      if (desk) await context.addCookies([{ name: 'sillage_session', value: desk.session, url: origin }])
      else if (!serverStorage) {
        await json(await context.request.post(origin + '/api/auth/setup', { data: { username: 'tester', displayName: 'Tester', password: 'transfer-test-password' } }))
        serverStorage = await context.storageState()
      }
      const user = await json(await context.request.get(origin + '/api/auth/me'))
      const settings = await json(await context.request.get(origin + '/api/me/settings'))
      assert.ok((await context.request.patch(origin + '/api/me/settings', { data: { onboarding: { ...settings.onboarding, pending: false } } })).ok())
      const project = async name => {
        const workspacePath = join(data, profile, name + width)
        await mkdir(workspacePath, { recursive: true })
        return json(await context.request.post(origin + '/api/projects', { data: { name, workspacePath, visibility: 'private' } }))
      }
      const source = await project('Sandbox'), target = await project('Appartement 3D')
      const id = randomUUID(), photo = join(source.workspacePath, 'photo.png')
      await writeFile(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
      const { db, sqlite } = openDatabase(join(env.SILLAGE_DATA_DIR, 'sillage.db'))
      db.insert(conversations).values({ id, projectId: source.id, userId: user.id, title: 'Peintures de l’appartement', agent: 'codex', config: JSON.stringify(defaultConfigFor('codex')), status: 'idle', createdAt: Date.now(), updatedAt: Date.now() }).run()
      const log = new EventLog(db)
      log.append(id, { type: 'message.completed', messageId: 'user', role: 'user', parentToolCallId: null, blocks: [{ type: 'text', text: 'Garde le beige chaud dans le bureau.' }] })
      log.append(id, { type: 'message.completed', messageId: 'agent', role: 'assistant', parentToolCallId: null, blocks: [{ type: 'text', text: 'La peinture est appliquée.\n\n![Capture avant transfert](' + photo + ')' }] })
      sqlite.close()
      const page = await context.newPage()
      page.setDefaultTimeout(20000)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(origin + '/p/' + source.id + '/c/' + id)
      await page.getByText('Garde le beige chaud dans le bureau.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Déplacer vers un autre projet', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Déplacer vers un autre projet', exact: true })
      await dialog.waitFor()
      assert.ok(await dialog.getByRole('button', { name: 'Déplacer la session', exact: true }).isDisabled())
      await dialog.getByRole('button', { name: 'Projet de destination', exact: true }).click()
      const selector = page.getByRole('dialog', { name: 'Projet de destination', exact: true })
      await selector.getByRole('textbox').fill('Appartement')
      await selector.getByRole('radio', { name: 'Appartement 3D', exact: true }).last().click()
      await page.screenshot({ path: join(shots, profile + '-' + width + '.png') })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      const movedResponse = page.waitForResponse(response => response.url().endsWith('/conversations/' + id + '/move'))
      await dialog.getByRole('button', { name: 'Déplacer la session', exact: true }).click()
      await json(await movedResponse)
      await page.waitForURL(origin + '/p/' + target.id + '/c/' + id)
      await page.getByText('Garde le beige chaud dans le bureau.', { exact: true }).waitFor()
      await page.waitForFunction(() => [...document.querySelectorAll('img')].some(image => image.alt === 'Capture avant transfert' && image.complete && image.naturalWidth > 0))
      const stored = await json(await context.request.get(origin + '/api/conversations/' + id))
      assert.equal(stored.id, id)
      assert.equal(stored.projectId, target.id)
      await page.reload()
      await page.getByText('Garde le beige chaud dans le bureau.', { exact: true }).waitFor()
      assert.deepEqual(errors, [])
      await context.close()
      console.log(profile + ' ' + width + ': same session, full history, old image, navigation and persistence passed')
    }
  }
} finally {
  await browser?.close()
  for (const child of children.reverse()) if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]) }
  await rm(data, { recursive: true, force: true })
}

