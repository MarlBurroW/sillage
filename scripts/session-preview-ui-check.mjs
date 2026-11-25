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

// Session details popover on the demo data: hover on desktop, pinned on a phone, in both themes.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-preview-check-'))
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
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-6000) })
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
  const apiPort = await freePort()
  const webPort = await freePort()
  const config = join(data, 'config.toml')
  await writeFile(config, ['claude', 'codex', 'opencode', 'grok'].map(agent => `[agents.${agent}]\nenabled = false\n`).join(''))
  const env = { ...process.env, SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data'), SILLAGE_WEB_ROOT: join(data, 'web') }
  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`http://127.0.0.1:${apiPort}/api/health`, server), ready(base, vite)])
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)

  // The demo journals hold tool calls but no priced turns: record some, and a context reading.
  const sql = `
    const db = new Database(process.argv[1]);
    const c = db.prepare("select id, user_id, project_id from conversations where title = 'Add offline caching for forecasts'").get();
    const add = db.prepare('insert into turn_usage (conversation_id, seq, model, ts, user_id, project_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    add.run(c.id, 1, 'claude-opus-5-5', Date.now(), c.user_id, c.project_id, 'claude', 42000, 18500, 2400000, 160000);
    add.run(c.id, 2, 'claude-opus-5-5', Date.now(), c.user_id, c.project_id, 'claude', 12000, 9400, 1100000, 40000);
    db.prepare('update conversations set context_used_tokens = 433300, context_max_tokens = 1000000, model = ? where id = ?').run('claude-opus-5-5', c.id);
    db.close();`
  const fill = run(['--input-type=module', '-e', `import Database from 'better-sqlite3'; ${sql}`, join(data, 'data/sillage.db')], serverDir, env)
  assert.equal((await once(fill, 'exit'))[0], 0, fill.diagnostics)

  const shots = process.env.SILLAGE_UI_SHOTS ?? await mkdtemp(join(tmpdir(), 'sillage-preview-shots-'))
  await mkdir(shots, { recursive: true })
  browser = await chromium.launch()
  const errors = []

  async function open(options, theme) {
    const context = await browser.newContext({ locale: 'fr-FR', serviceWorkers: 'block', ...options })
    await context.addInitScript(([origin, value]) => {
      if (window === window.top && location.origin === origin) { localStorage.setItem('sillage.locale', 'fr'); localStorage.setItem('sillage.theme', value) }
    }, [new URL(base).origin, theme])
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(12000)
    await page.goto(base)
    await page.getByRole('textbox', { name: "Nom d'utilisateur", exact: true }).fill('alex')
    await page.getByRole('textbox', { name: 'Mot de passe', exact: true }).fill('sillage-demo')
    await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
    await page.waitForURL(/\/p\/[^/]+\/c\/[^/]+$/)
    // The account's saved theme wins over local storage once signed in.
    await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
    return page
  }

  for (const theme of ['dark', 'light']) {
    const page = await open({ viewport: { width: 1440, height: 900 } }, theme)
    const row = page.locator('.sidebar-layout:visible [data-session-details]').first()
    await row.waitFor()
    // Pin the hero session's details: hover previews vanish when the pointer leaves for a screenshot.
    const hero = page.locator('.sidebar-layout:visible').getByText('Add offline caching for forecasts', { exact: true }).first()
    await hero.hover()
    const tooltip = page.locator('.session-preview-tooltip')
    await tooltip.waitFor()
    await tooltip.locator('.session-preview-tools li').first().waitFor()
    const tiles = await tooltip.locator('.session-preview-tiles dd').allTextContents()
    assert.ok(tiles[0].includes('$'), `cost tile shows an amount: ${tiles}`)
    assert.match(tiles[1], /^\d+/, 'tool count')
    await tooltip.locator('.session-preview-gauge').waitFor()
    await page.screenshot({ path: join(shots, `desktop-${theme}.png`) })
    await tooltip.screenshot({ path: join(shots, `popover-${theme}.png`) })
    await page.context().close()
  }

  const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, 'dark')
  await phone.locator('[data-navigation-trigger]').click()
  const drawer = phone.locator('.sidebar-layout:visible')
  const heroId = phone.url().split('/c/')[1]
  await drawer.locator(`[data-session-details="${heroId}"]`).tap()
  const pinned = phone.locator('.session-preview-popover')
  await pinned.waitFor()
  await pinned.locator('.session-preview-tiles').waitFor()
  await delay(300)
  const box = await pinned.boundingBox()
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390 + 1, `popover fits the phone: ${JSON.stringify(box)}`)
  await phone.screenshot({ path: join(shots, 'phone-dark.png') })
  await phone.context().close()

  assert.deepEqual(errors, [])
  console.log(`Session preview verified: tiles, context gauge, tools, card, phone fit. Screenshots: ${shots}`)
} finally {
  await browser?.close()
  for (const child of processes) child.kill()
  await rm(data, { recursive: true, force: true })
}
