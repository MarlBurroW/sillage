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

// `@` mentions: a project folder ignored by an enclosing repository still completes, folders are
// offered and open with Tab or their chevron, and only whole mentions leave with the message.
// Disposable database/project/servers, no CLI launched: the send request is intercepted.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const require = createRequire(join(serverDir, 'package.json'))
const data = await mkdtemp(join(tmpdir(), 'sillage-mentions-ui-'))
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

  // A dotfiles-style repository ignores everything below it, the project folder included: git
  // lists nothing there, which once left the completion empty.
  const home = join(data, 'home')
  const mapper = join(home, 'mapper')
  await mkdir(join(mapper, 'src/lib'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: home })
  await writeFile(join(home, '.gitignore'), '*\n')
  await writeFile(join(mapper, 'README.md'), '# Mapper\n')
  await writeFile(join(mapper, 'src/main.ts'), 'export {}\n')
  await writeFile(join(mapper, 'src/lib/geo.ts'), 'export {}\n')

  const Sqlite = require('better-sqlite3')
  const db = new Sqlite(join(env.SILLAGE_DATA_DIR, 'sillage.db'))
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get('Nimbus')
  db.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(mapper, project.id)
  const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? AND worktree_id IS NULL AND archived_at IS NULL LIMIT 1').get(project.id)
  db.close()

  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])

  browser = await chromium.launch()
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const phone = viewport.width < 600
    const context = await browser.newContext({ viewport, locale: 'fr-FR', serviceWorkers: 'block', hasTouch: phone, isMobile: phone })
    await context.route('**/api/agents/*/models*', (route) => route.fulfill({ json: { models: [], modes: [], account: null, fetchedAt: Date.now() } }))
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
    await page.goto(`${base}/p/${project.id}/c/${conversation.id}`)
    const input = page.locator('textarea:visible').last()
    await input.waitFor()
    const list = page.getByRole('listbox', { name: 'Fichiers et dossiers à mentionner' })
    const options = () => list.getByRole('option').evaluateAll((nodes) => nodes.map((node) => node.querySelector('.font-mono')?.textContent))

    // Empty query: folders and files of the ignored folder, shortest first.
    await input.fill('voir @')
    await list.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[role=listbox] [role=option]').length >= 4)
    assert.deepEqual(await options(), ['src/', 'src/lib/', 'README.md', 'src/main.ts', 'src/lib/geo.ts'])
    if (!phone) await page.screenshot({ path: join(shots, 'mentions-folders-desktop.png') })

    if (phone) {
      // Touch: the chevron opens the folder, a tap on the row mentions it.
      await list.getByRole('button', { name: 'Ouvrir le dossier (Tab)' }).first().tap()
      await page.waitForFunction(() => document.querySelector('[role=listbox] [role=option] .font-mono')?.textContent === 'src/lib/')
      assert.equal(await input.inputValue(), 'voir @src/')
      await page.screenshot({ path: join(shots, 'mentions-folders-phone.png') })
      await list.getByRole('option').first().tap()
      assert.equal(await input.inputValue(), 'voir @src/lib/ ')
    } else {
      // Tab opens a folder without mentioning it; Enter mentions the file chosen inside.
      await input.pressSequentially('sr')
      await page.waitForFunction(() => document.querySelector('[role=listbox] [role=option] .font-mono')?.textContent === 'src/')
      await input.press('Tab')
      await page.waitForFunction(() => document.querySelector('[role=listbox] [role=option] .font-mono')?.textContent === 'src/lib/')
      assert.equal(await input.inputValue(), 'voir @src/')
      assert.deepEqual(await options(), ['src/lib/', 'src/main.ts'])
      await input.press('ArrowDown')
      await input.press('Enter')
      assert.equal(await input.inputValue(), 'voir @src/main.ts ')
      // A pick puts the caret back on the next frame: typing sooner would land before it.
      await delay(100)
      // Enter on a folder mentions it as a whole.
      await input.pressSequentially('et @lib')
      await page.waitForFunction(() => document.querySelector('[role=listbox] [role=option] .font-mono')?.textContent === 'src/lib/')
      await input.press('Enter')
      assert.equal(await input.inputValue(), 'voir @src/main.ts et @src/lib/ ')
      await delay(100)
      await input.pressSequentially('@zzqq')
      await page.getByText('Aucun fichier ni dossier ne correspond.').waitFor()
      await input.fill('voir @src/main.ts et @src/lib/ ')
    }

    await input.press('Enter')
    for (let i = 0; i < 50 && !sent; i++) await delay(100)
    assert.ok(sent, 'message not sent')
    // The opened folder `src/` was never picked to stay: only whole mentions leave.
    assert.deepEqual([...sent.mentions].sort(), phone ? ['src/lib/'] : ['src/lib/', 'src/main.ts'])
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('mentions UI check passed')
} finally {
  await browser?.close()
  for (const child of children) child.kill()
  await rm(data, { recursive: true, force: true })
}
