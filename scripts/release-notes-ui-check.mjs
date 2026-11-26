import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

// Release notes page on a disposable server. GitHub's replies are fixtures served to the
// browser, so the check does not depend on the network or the 60 requests/hour limit; the
// server side is covered by apps/server/test/release-checker.test.ts.
const root = fileURLToPath(new URL('../', import.meta.url))
const serverDir = join(root, 'apps/server')
const data = await mkdtemp('/var/tmp/sillage-release-notes-ui-')
const children = []
let browser

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}
function run(args, env) {
  const child = spawn(process.execPath, args, { cwd: serverDir, env, stdio: 'pipe' })
  child.diagnostics = ''
  children.push(child)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { child.diagnostics = (child.diagnostics + chunk).slice(-8000) })
  return child
}
async function ready(origin, child) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw Error(child.diagnostics)
    if (await fetch(`${origin}/api/health`).then((r) => r.ok).catch(() => false)) return
    await delay(100)
  }
  throw Error(child.diagnostics)
}

// The three shapes GitHub holds: a summary sentence first, a warning quote before it, a heading first.
const NOTES = {
  'v0.44.0': '`@` mentions now offer folders and work in every project.\n\n**Mentions**\n- Typing `@` now offers folders as well as files.\n\nServer and Desktop editions. No database migration.',
  'v0.43.0': 'Agents get a browser you can watch.\n\n**Browser**\n- A live view of the agent browser.',
  'v0.42.0': 'Feedback from OpenCode users: a model picker you can find your way in.\n\n**Models**\n- Models grouped by provider.',
  'v0.41.0': '> **Desktop apps are not attached to this release.**\n\nA command palette that works inside the current project.\n\n**Palette**\n- Project token.',
  'v0.33.0': '## Highlights\n\n- Session wall.',
}
const TAGS = Object.keys(NOTES)
function history(installed, checkError = null) {
  const index = TAGS.indexOf(installed)
  return {
    version: installed.slice(1),
    updateAvailable: index > 0,
    checkedAt: new Date().toISOString(),
    checkError,
    releases: checkError ? [] : TAGS.map((tag, i) => ({
      tag,
      name: tag,
      publishedAt: new Date(Date.UTC(2026, 10, 26 - i * 3)).toISOString(),
      body: NOTES[tag],
      htmlUrl: `https://github.com/MarlBurroW/sillage/releases/tag/${tag}`,
      relation: i < index ? 'newer' : i === index ? 'installed' : 'older',
    })),
  }
}
function versionInfo(installed) {
  const all = history(installed)
  return {
    version: all.version, channel: 'none', latest: TAGS[0].slice(1), updateAvailable: all.updateAvailable,
    releases: all.releases.filter((entry) => entry.relation === 'newer'), checkedAt: all.checkedAt, checkError: null,
  }
}
async function stub(context, installed, checkError = null) {
  await context.unroute('**/api/system/version*').catch(() => undefined)
  await context.unroute('**/api/system/releases').catch(() => undefined)
  await context.route('**/api/system/version*', (route) => route.fulfill({ json: versionInfo(installed) }))
  await context.route('**/api/system/releases', (route) => route.fulfill({ json: history(installed, checkError) }))
}
const row = (page, tag) => page.locator('article').filter({ has: page.getByRole('heading', { name: tag, exact: true }) })
const toggle = (page, tag) => row(page, tag).getByRole('button')

try {
  const config = join(data, 'config.toml')
  await writeFile(config, '[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n[agents.opencode]\nenabled = false\n[agents.grok]\nenabled = false\n')
  const port = await freePort()
  const env = { ...process.env, NODE_ENV: 'development', TMPDIR: '/var/tmp', SILLAGE_PORT: String(port), SILLAGE_HOST: '127.0.0.1', SILLAGE_CONFIG: config, SILLAGE_DATA_DIR: join(data, 'server'), SILLAGE_WEB_ROOT: join(root, 'apps/web/dist'), GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.test', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.test' }
  const origin = `http://127.0.0.1:${port}`
  const server = run(['--import', 'tsx', 'src/main.ts'], env)
  await ready(origin, server)
  const seed = run(['--import', 'tsx', 'src/cli/demo-seed.ts'], env)
  assert.equal((await once(seed, 'exit'))[0], 0, seed.diagnostics)

  browser = await chromium.launch()
  for (const width of [1440, 390]) {
    const phone = width < 600
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: phone, hasTouch: phone, locale: 'fr-FR', serviceWorkers: 'block' })
    await context.addInitScript(() => localStorage.setItem('sillage.locale', 'fr'))
    assert.ok((await context.request.post(`${origin}/api/auth/login`, { data: { username: 'alex', password: 'sillage-demo' } })).ok())
    await stub(context, 'v0.42.0')
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))

    // Reached from the settings list, next to About.
    await page.goto(`${origin}/settings`)
    await page.getByRole('navigation', { name: 'Réglages', exact: true }).getByRole('link', { name: /Notes de version/ }).click()
    await page.getByRole('heading', { name: 'Notes de version', level: 2 }).waitFor()
    assert.match(page.url(), /\/settings\/notes-de-version$/)

    // Behind by two versions: both are open and marked, so is the installed one; older ones fold.
    await page.getByRole('heading', { name: 'La version 0.44.0 est disponible' }).waitFor()
    assert.equal(await toggle(page, 'v0.44.0').getAttribute('aria-expanded'), 'true')
    assert.equal(await toggle(page, 'v0.43.0').getAttribute('aria-expanded'), 'true')
    assert.equal(await toggle(page, 'v0.42.0').getAttribute('aria-expanded'), 'true')
    assert.equal(await toggle(page, 'v0.41.0').getAttribute('aria-expanded'), 'false')
    assert.equal(await row(page, 'v0.44.0').getByText('Disponible', { exact: true }).count(), 1)
    assert.equal(await row(page, 'v0.42.0').getByText('Installée', { exact: true }).count(), 1)
    assert.equal(await row(page, 'v0.41.0').getByText(/Disponible|Installée/).count(), 0)
    await row(page, 'v0.44.0').getByText('Typing @ now offers folders as well as files.', { exact: false }).waitFor()
    // A folded row shows its opening sentence, past a leading warning; a heading-first one shows nothing.
    assert.equal((await row(page, 'v0.41.0').locator('p').innerText()).trim(), 'A command palette that works inside the current project.')
    assert.equal(await row(page, 'v0.33.0').locator('p').count(), 0)
    await page.screenshot({ path: `/var/tmp/sillage-release-notes-${width}.png`, fullPage: true })

    // Rows open and fold on demand.
    await toggle(page, 'v0.41.0').click()
    await row(page, 'v0.41.0').getByText('Project token.').waitFor()
    await toggle(page, 'v0.44.0').click()
    assert.equal(await toggle(page, 'v0.44.0').getAttribute('aria-expanded'), 'false')
    assert.equal((await row(page, 'v0.44.0').locator('p').innerText()).trim(), '@ mentions now offer folders and work in every project.')

    // The update itself stays on About, and About leads back to the notes.
    await page.getByRole('button', { name: 'Aller à la mise à jour' }).click()
    await page.getByRole('heading', { name: 'À propos', level: 2 }).waitFor()
    await page.getByRole('heading', { name: 'Nouveautés de la version 0.44.0' }).waitFor()
    if (!phone) {
      const menu = page.getByRole('navigation', { name: 'Réglages', exact: true })
      assert.equal(await menu.getByRole('link', { name: /À propos/ }).getAttribute('aria-current'), 'page')
      assert.equal(await menu.getByRole('link', { name: /Notes de version/ }).getAttribute('aria-current'), null)
    }
    await page.screenshot({ path: `/var/tmp/sillage-release-notes-about-${width}.png`, fullPage: true })
    await page.getByRole('button', { name: 'Notes de version' }).click()
    await page.getByRole('heading', { name: 'Notes de version', level: 2 }).waitFor()

    // Up to date: no update card, the installed version first and open.
    await stub(context, 'v0.44.0')
    await page.reload()
    await page.getByRole('heading', { name: 'Notes de version', level: 2 }).waitFor()
    await row(page, 'v0.44.0').getByText('Installée', { exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: /est disponible/ }).count(), 0)
    assert.equal(await toggle(page, 'v0.44.0').getAttribute('aria-expanded'), 'true')
    assert.equal(await toggle(page, 'v0.43.0').getAttribute('aria-expanded'), 'false')

    // GitHub unreachable with nothing cached: say so instead of an empty page.
    await stub(context, 'v0.44.0', 'rate_limited')
    await page.reload()
    await page.getByText('GitHub limite temporairement les requêtes', { exact: false }).waitFor()

    if (!phone) {
      // The palette finds the page among settings.
      await stub(context, 'v0.44.0')
      await page.goto(`${origin}/settings/a-propos`)
      await page.getByRole('heading', { name: 'À propos', level: 2 }).waitFor()
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: 'Rechercher', exact: true })
      await palette.waitFor()
      await page.keyboard.type('notes de version')
      await palette.getByRole('option', { name: /Notes de version/ }).first().click()
      await page.getByRole('heading', { name: 'Notes de version', level: 2 }).waitFor()
    }

    assert.deepEqual(errors, [])
    await context.close()
    console.log(`release notes ok at ${width}px`)
  }
} finally {
  await browser?.close()
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  await rm(data, { recursive: true, force: true })
}
