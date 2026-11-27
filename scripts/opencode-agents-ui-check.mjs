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

// OpenCode sub-agents under `@`: they come before files, by name prefix, pick with Enter or a tap
// and leave as `@name` in the text. Another CLI keeps a files-only list. Disposable database,
// project and servers, no CLI launched: the conversation is shown as OpenCode, its catalog is
// mocked, and the send request is intercepted.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const require = createRequire(join(serverDir, 'package.json'))
const data = await mkdtemp(join(tmpdir(), 'sillage-opencode-agents-ui-'))
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

  // A file sharing the agent's prefix: both kinds in one list, agents first.
  const workspace = join(data, 'workspace')
  await mkdir(workspace, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  await writeFile(join(workspace, 'explore-notes.md'), '# Notes\n')

  const Sqlite = require('better-sqlite3')
  const db = new Sqlite(join(env.SILLAGE_DATA_DIR, 'sillage.db'))
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get('Nimbus')
  db.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(workspace, project.id)
  const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? AND worktree_id IS NULL AND archived_at IS NULL LIMIT 1').get(project.id)
  db.close()

  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])

  const agents = [{ name: 'general', description: 'General-purpose work' }, { name: 'explore', description: 'Fast codebase search' }]
  const opencodeConfig = { agent: 'opencode', model: '', variant: '', primaryAgent: 'build', permissions: { edit: 'ask', bash: 'ask', webfetch: '' }, additionalDirectories: [], mcpServers: [], sillageMcp: true, skillLibrary: true }

  browser = await chromium.launch()
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const phone = viewport.width < 600
    const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block', hasTouch: phone, isMobile: phone })
    // Every CLI's catalog lists the agents: only OpenCode may offer them.
    await context.route('**/api/agents/*/models*', (route) => route.fulfill({ json: { models: [], modes: [], account: null, outputStyles: [], fastMode: null, agents, fetchedAt: Date.now() } }))
    let sent = null
    await context.route(`**/api/conversations/${conversation.id}/messages`, (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      sent = route.request().postDataJSON()
      return route.fulfill({ status: 202, json: {} })
    })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())

    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const input = page.locator('textarea:visible').last()

    // Claude conversation: files only.
    await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
    await input.waitFor()
    await input.fill('voir @')
    await page.getByRole('listbox', { name: 'Fichiers et dossiers à mentionner' }).waitFor()
    assert.equal(await page.getByRole('option', { name: /@explore/ }).count(), 0)

    // The same conversation shown as OpenCode.
    await context.route(`**/api/conversations/${conversation.id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const json = await response.json()
      return route.fulfill({ response, json: { ...json, agent: 'opencode', model: null, config: opencodeConfig } })
    })
    await page.reload()
    await input.waitFor()
    const list = page.getByRole('listbox', { name: 'Sous-agents, fichiers et dossiers à mentionner' })
    const options = () => list.getByRole('option').evaluateAll((nodes) => nodes.map((node) => node.textContent))

    await input.fill('voir @')
    await list.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[role=listbox] [role=option]').length >= 3)
    const all = await options()
    assert.ok(all[0].startsWith('@explore') && all[0].includes('Fast codebase search'), all[0])
    assert.ok(all[1].startsWith('@general'), all[1])
    assert.ok(all.slice(2).some((text) => text.includes('explore-notes.md')), all.join(' | '))

    // Typed rather than filled: React learns the caret from key events, and a filled value would
    // make the first key's selection event reset the active row.
    await input.fill('voir ')
    await input.pressSequentially('@ex')
    await page.waitForFunction(() => document.querySelectorAll('[role=listbox] [role=option]').length === 2)
    await page.screenshot({ path: join(shots, `opencode-agents-${phone ? 'phone' : 'desktop'}.png`) })
    if (phone) {
      await list.getByRole('option').first().tap()
    } else {
      // The agent first; ArrowDown reaches the file below it, ArrowUp comes back.
      await input.press('ArrowDown')
      await input.press('ArrowUp')
      await input.press('Enter')
    }
    assert.equal(await input.inputValue(), 'voir @explore ')
    await delay(100)
    if (!phone) {
      await input.pressSequentially('et @ex')
      await page.waitForFunction(() => document.querySelectorAll('[role=listbox] [role=option]').length === 2)
      await input.press('ArrowDown')
      await input.press('Enter')
      assert.equal(await input.inputValue(), 'voir @explore et @explore-notes.md ')
    }

    await input.press('Enter')
    for (let i = 0; i < 50 && !sent; i++) await delay(100)
    assert.ok(sent, 'message not sent')
    // The agent leaves in the text, the file as a mention.
    assert.ok(sent.text.startsWith('voir @explore'), sent.text)
    assert.deepEqual(sent.mentions, phone ? [] : ['explore-notes.md'])
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('OpenCode agents UI check passed')
} finally {
  await browser?.close()
  for (const child of children) child.kill()
  await rm(data, { recursive: true, force: true })
}
