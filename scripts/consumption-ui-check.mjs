import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Disposable database and servers. Consumption is written straight to `turn_usage`, as the
// recorder would: the page is what is checked here, the recording has its own server tests.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const webDir = join(root, 'apps/web')
const data = await mkdtemp(join(tmpdir(), 'sillage-consumption-ui-'))
// Set to keep the screenshots somewhere they can be looked at.
const shots = process.env.SILLAGE_UI_SHOTS
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
  const env = { ...process.env, NODE_ENV: 'development', SILLAGE_PORT: String(apiPort), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'data') }
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], serverDir, env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)

  const Sqlite = createRequire(join(serverDir, 'package.json'))('better-sqlite3')
  const db = new Sqlite(join(env.SILLAGE_DATA_DIR, 'sillage.db'))
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get('Nimbus')
  const conversation = db.prepare('SELECT * FROM conversations WHERE project_id = ? LIMIT 1').get(project.id)
  const admin = db.prepare('SELECT * FROM users WHERE username = ?').get('alex')
  const other = db.prepare('SELECT * FROM users WHERE id != ? LIMIT 1').get(admin.id)
  // The demo's own journals would be read at start and blur the expected totals.
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('turnUsageHistory', '1', 0)").run()
  const insert = db.prepare(`INSERT INTO turn_usage (conversation_id, seq, model, ts, user_id, project_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  // Past days at noon, away from DST shifts. Today halfway between midnight and now: the report
  // ends at the current instant, so a turn dated noon today vanished on morning runs (card #109).
  const now = Date.now()
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const daysAgo = (days) => {
    if (days === 0) return Math.floor((midnight + now) / 2)
    const day = new Date(midnight)
    day.setDate(day.getDate() - days)
    return day.setHours(12, 0, 0, 0)
  }
  // Opus 5.5 at 4 / 20 / 0.2 / 5 / 8 dollars per million: 4 + 2 + 0.4 + 0.5 + 0.8 = 7.70 a day.
  for (const days of [0, 1, 3]) insert.run(conversation.id, 1000 + days, 'claude-opus-5-5', daysAgo(days), admin.id, project.id, 'claude', 1_000_000, 100_000, 2_000_000, 100_000, 100_000)
  // GPT-6 Astra at 10 / 50: 1 + 0.5 = 1.50, outside any project, on a session since deleted.
  insert.run('deleted-session', 1, 'gpt-6-astra', daysAgo(1), other?.id ?? admin.id, null, 'codex', 100_000, 10_000, 0, 0, 0)
  insert.run(conversation.id, 2000, 'house-model', daysAgo(0), admin.id, project.id, 'opencode', 5_000, 5_000, 0, 0, 0)
  // Outside the default thirty days.
  insert.run(conversation.id, 3000, 'claude-opus-5-5', daysAgo(200), admin.id, project.id, 'claude', 1_000_000, 0, 0, 0, 0)
  db.close()

  const server = run(['--import', 'tsx', 'src/main.ts'], serverDir, env)
  const vite = run([join(webDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webDir, env)
  const base = `http://127.0.0.1:${webPort}`
  await Promise.all([ready(`${base}/api/health`, server), ready(base, vite)])

  browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
  assert.ok((await context.request.post(`${base}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  // The rail entry opens the page full width: no column names another space beside it.
  await page.goto(base)
  await page.locator('[data-nav-space="consumption"]').click()
  await page.waitForURL(/\/consumption$/)
  const view = page.locator('[data-consumption-page]')
  await view.getByRole('heading', { level: 1, name: 'Consommation' }).waitFor()
  assert.equal(await page.locator('[data-nav-space="consumption"]').getAttribute('aria-current'), 'page')
  assert.equal(await page.locator('[data-nav-column]').count(), 0)

  // Thirty days by default: three Opus days, one Codex turn; the unpriced model adds tokens only.
  const tile = (label) => view.locator('dl > div').filter({ hasText: label }).locator('dd').first()
  await tile('Coût équivalent API').filter({ hasText: '24,60' }).waitFor()
  assert.match(await tile('Sessions').innerText(), /^2$/)
  await view.getByText('Pas de prix public pour house-model').waitFor()

  // One bar per day of the period, today last; the chart details a bar on hover and by keyboard.
  const chart = view.locator('[data-consumption-chart="cost"]')
  assert.equal(await chart.locator('[data-bucket]').count(), 30)
  // The unpriced model weighs nothing in dollars: it only shows once tokens are charted.
  assert.equal(await chart.locator('.consumption-segment').count(), 4)
  for (const cli of ['Claude Code', 'Codex']) await chart.getByRole('list', { name: 'CLI' }).getByText(cli, { exact: true }).waitFor()
  await chart.locator('[data-bucket]').nth(28).hover()
  const tooltip = chart.locator('[data-consumption-tooltip]')
  await tooltip.getByText('7,70').waitFor()
  await tooltip.getByText('1,50').waitFor()
  await tooltip.getByText('9,20').waitFor()
  // The arrows carry on from the bar under the pointer: today, then back to yesterday.
  await chart.getByRole('group').focus()
  await page.keyboard.press('ArrowRight')
  await tooltip.getByText('9,20').waitFor({ state: 'detached' })
  await tooltip.getByText('7,70').waitFor()
  await page.keyboard.press('ArrowLeft')
  await tooltip.getByText('9,20').waitFor()
  await page.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'detached' })
  await view.getByRole('radio', { name: 'Tokens' }).click()
  assert.equal(await view.locator('[data-consumption-chart="tokens"] .consumption-segment').count(), 5)

  // One breakdown at a time.
  const table = view.locator('[data-consumption-breakdown]')
  const row = (name) => table.getByRole('row').filter({ hasText: name })
  await row('Claude Code').getByText('23,10').waitFor()
  await view.getByRole('tab', { name: 'Modèle' }).click()
  await row('claude-opus-5-5').getByText('4,00 $US en entrée · 20,00 $US en sortie').waitFor()
  await row('house-model').getByText('Pas de prix public').waitFor()
  await view.getByRole('tab', { name: 'Projet' }).click()
  await row('Nimbus').getByRole('link', { name: 'Nimbus' }).waitFor()
  await row('Hors projet').getByText('1,50').waitFor()
  await view.getByRole('tab', { name: 'Session' }).click()
  await row('Session supprimée').getByText('1,50').waitFor()
  assert.equal(await row(conversation.title).getByRole('link').getAttribute('href'), `/p/${project.id}/c/${conversation.id}`)
  if (other) await view.getByRole('tab', { name: 'Compte' }).waitFor()

  // A longer period switches to months and reaches the old turn; the address keeps the choice.
  await view.getByRole('radio', { name: 'Tout' }).click()
  await page.waitForURL(/period=all/)
  await tile('Coût équivalent API').filter({ hasText: '28,60' }).waitFor()
  await view.getByRole('heading', { name: 'Par mois' }).waitFor()
  await page.reload()
  await tile('Coût équivalent API').filter({ hasText: '28,60' }).waitFor()

  // Prices: where they come from, and the admin's way to ask for them again.
  await view.locator('[data-consumption-prices]').waitFor()
  await view.getByRole('button', { name: 'Mettre à jour les prix' }).click()
  await page.waitForResponse((response) => response.url().endsWith('/api/consumption/prices/refresh'))
  if (shots) await page.screenshot({ path: join(shots, 'consumption-desktop.png'), fullPage: true })

  // Phone: the period becomes a select, the table keeps a name, the tokens and the cost.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}/consumption`)
  await tile('Coût équivalent API').filter({ hasText: '24,60' }).waitFor()
  assert.equal(await view.getByRole('radiogroup', { name: 'Période' }).isVisible(), false)
  await view.getByRole('combobox', { name: 'Période' }).click()
  await page.getByRole('option', { name: '7 jours' }).click()
  await page.waitForURL(/period=7d/)
  await page.waitForFunction(() => document.querySelectorAll('[data-consumption-chart] [data-bucket]').length === 7)
  assert.equal(await view.getByRole('columnheader', { name: 'Lecture cache' }).isVisible(), false)
  await view.getByRole('columnheader', { name: 'Tokens' }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the page does not scroll sideways on a phone')
  if (shots) await page.screenshot({ path: join(shots, 'consumption-mobile.png'), fullPage: true })

  // The command palette reaches it too.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base)
  await page.getByRole('button', { name: /^Rechercher/ }).first().waitFor()
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Rechercher', exact: true })
  await palette.getByRole('combobox').fill('Consommation')
  await palette.getByRole('option', { name: /Consommation/ }).first().click()
  await page.waitForURL(/\/consumption$/)

  assert.deepEqual(errors, [])
  console.log('OK: rail entry, totals, chart hover and keyboard, breakdowns, periods, prices, phone layout and palette.')
} finally {
  await browser?.close()
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  }
  await rm(data, { recursive: true, force: true })
}
