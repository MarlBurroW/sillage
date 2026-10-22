#!/usr/bin/env node
/**
 * Capture site screens from an already running, seeded demo instance
 * (see `apps/server/src/cli/demo-seed.ts`, then `pnpm --filter @sillage/server
 * search:reindex` so search palette has results).
 *
 *   SILLAGE_URL=http://127.0.0.1:7517 node scripts/screenshots.mjs
 *   SILLAGE_SHOTS=schedule node scripts/screenshots.mjs   # only some views
 *
 * Each view produces `<name>-dark.png` and `<name>-light.png` in `site/screenshots/`.
 * Locale forced to English because the site is English.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.SILLAGE_URL ?? 'http://127.0.0.1:7517'
const USERNAME = process.env.SILLAGE_DEMO_USER ?? 'alex'
const PASSWORD = process.env.SILLAGE_DEMO_PASSWORD ?? 'sillage-demo'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'screenshots')

// Site palette: native settings taken from the reference screenshot.
// No image filters or retouching; the interface renders these colors itself.
const APPEARANCE = { hue: 318, tint: 0.25, lift: -0.01 }

const VIEWPORT = { width: 1600, height: 1000 }
/** Wider for the board so all five columns fit without cropping. */
const BOARD_VIEWPORT = { width: 1840, height: 1100 }

async function fetchJson(context, path) {
  const response = await context.request.get(`${BASE_URL}${path}`)
  if (!response.ok()) throw new Error(`GET ${path} failed: ${response.status()}`)
  return response.json()
}

/** Find seeded IDs to build the view list. */
async function resolveTargets(context) {
  const projects = await fetchJson(context, '/api/projects')
  const project = (name) => {
    const found = projects.find((p) => p.name === name)
    if (!found) throw new Error(`Project "${name}" not found — run the demo seed first.`)
    return found
  }
  const nimbus = project('Nimbus')
  const atlas = project('Atlas API')
  const conversationsOf = async (projectId) =>
    fetchJson(context, `/api/projects/${projectId}/conversations`)
  const byTitle = (list, title) => {
    const found = list.find((c) => c.title === title)
    if (!found) throw new Error(`Conversation "${title}" not found — reseed the demo data.`)
    return found
  }
  const nimbusThreads = await conversationsOf(nimbus.id)
  const atlasThreads = await conversationsOf(atlas.id)
  return {
    nimbus,
    hero: byTitle(nimbusThreads, 'Add offline caching for forecasts'),
    permission: byTitle(nimbusThreads, 'Refactor settings storage'),
    release: byTitle(nimbusThreads, 'Release notes for v0.9'),
    atlas,
    codex: byTitle(atlasThreads, 'Fix the flaky retry test'),
  }
}

/**
 * Views to capture. `interact` performs an action after loading (open a drawer,
 * palette…); `viewport` overrides the default size for a view.
 */
function buildShots(t) {
  return [
    { name: 'login', path: '/login', waitFor: 'input[autocomplete="username"]', anonymous: true },
    {
      name: 'hero',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
    },
    {
      name: 'permission',
      path: `/p/${t.nimbus.id}/c/${t.permission.id}`,
      waitFor: 'text=migrate-settings',
    },
    {
      name: 'codex',
      path: `/p/${t.atlas.id}/c/${t.codex.id}`,
      waitFor: 'text=advances the fake timer',
    },
    {
      name: 'release',
      path: `/p/${t.nimbus.id}/c/${t.release.id}`,
      waitFor: 'text=Vector radar tiles',
    },
    {
      name: 'board',
      path: `/p/${t.nimbus.id}/board`,
      waitFor: 'text=Offline caching for forecasts',
      viewport: BOARD_VIEWPORT,
    },
    {
      name: 'card',
      path: `/p/${t.nimbus.id}/board?carte=2`,
      waitFor: 'role=button[name="Edit card"]',
      viewport: BOARD_VIEWPORT,
    },
    {
      name: 'search',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      interact: async (page) => {
        await page.keyboard.press('Control+k')
        const input = await page.waitForSelector('div[role="dialog"] input', { timeout: 10000 })
        await input.type('offline', { delay: 40 })
        // Results arrive in one request with no completion marker: allow a small margin.
        await page.waitForTimeout(1200)
      },
    },
    {
      name: 'schedule',
      path: `/p/${t.nimbus.id}/schedules`,
      waitFor: 'text=CLI release watch',
      interact: async (page) => {
        await page.getByRole('button', { name: /Run history/ }).click()
        await page.getByText('finished').first().waitFor({ timeout: 10000 })
      },
    },
    {
      // Project page: Worktrees compares each tree against main.
      name: 'worktrees',
      path: `/p/${t.nimbus.id}`,
      waitFor: 'text=feat/radar-prefetch',
    },
    { name: 'settings-mcp', path: '/settings/mcp', waitFor: 'text=playwright' },
    { name: 'settings-appearance', path: '/settings/apparence', waitFor: 'role=heading[name="Appearance"]' },
    // Side-panel views go last: their `storage` (open panel) stays in context,
    // so nothing should be captured afterward.
    {
      name: 'panel-files',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      storage: { 'sillage.panelOpen': '1' },
      viewport: BOARD_VIEWPORT,
      interact: async (page) => {
        const panel = page.locator('[data-panel="workspace"]')
        await panel.waitFor({ timeout: 10000 })
        // Expand to the file, then wait for editor content.
        await panel.locator('text=src').first().click()
        await panel.locator('text=lib').first().click()
        await panel.locator('text=forecast.ts').first().click()
        await panel.locator('text=API_BASE').first().waitFor({ timeout: 10000 })
      },
    },
    {
      name: 'panel-git',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      // Wide enough for graph and working tree side by side.
      storage: { 'sillage.panelOpen': '1', 'sillage.panelDockedWidth': '1040' },
      viewport: BOARD_VIEWPORT,
      interact: async (page) => {
        const panel = page.locator('[data-panel="workspace"]')
        await panel.waitFor({ timeout: 10000 })
        // Panel rail has icons: tab name is its aria-label.
        await panel.getByRole('button', { name: 'Git', exact: true }).click()
        await panel.locator('text=Cache the last forecast per city').first().waitFor({ timeout: 10000 })
        // Expand main-file diff to show real hunks.
        await panel.locator('text=src/lib/forecast.ts').first().click()
        await panel.locator('text=fromCache').first().waitFor({ timeout: 10000 })
      },
    },
  ]
}

async function shoot(page, shot, file) {
  await page.setViewportSize(shot.viewport ?? VIEWPORT)
  await page.goto(`${BASE_URL}${shot.path}`)
  if (shot.storage) {
    // Keys read at module load (open panel…) require a reload.
    await page.evaluate((entries) => {
      for (const [key, value] of entries) localStorage.setItem(key, value)
    }, Object.entries(shot.storage))
    await page.reload()
  }
  if (shot.waitFor) await page.waitForSelector(shot.waitFor, { timeout: 15000 })
  if (shot.interact) await shot.interact(page)
  // Entry transitions and WebSocket stream settle quickly.
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(OUT_DIR, file) })
  console.log(`✓ ${file}`)
}

async function captureTheme(browser, theme, shots) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: 'en-US',
    colorScheme: theme === 'light' ? 'light' : 'dark',
    serviceWorkers: 'block',
  })
  await context.addInitScript(({ theme, values }) => {
    localStorage.setItem('sillage.theme', theme)
    document.documentElement.dataset.theme = theme
    for (const [key, value] of Object.entries(values)) {
      localStorage.setItem(`sillage.${key}`, String(value))
    }
  }, { theme, values: APPEARANCE })

  const page = await context.newPage()
  // Capture sign-in page before setting session cookie.
  for (const shot of shots.filter((s) => s.anonymous)) {
    await shoot(page, shot, `${shot.name}-${theme}.png`)
  }
  const login = await context.request.post(`${BASE_URL}/api/auth/login`, {
    data: { username: USERNAME, password: PASSWORD },
  })
  if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`)
  // Account is authoritative after sign-in: keep its copy synchronized with cache.
  const settings = await context.request.patch(`${BASE_URL}/api/me/settings`, {
    data: { appearance: { theme, syntax: 'sillage', values: APPEARANCE } },
  })
  if (!settings.ok()) throw new Error(`Appearance update failed: ${settings.status()}`)
  for (const shot of shots.filter((s) => !s.anonymous)) {
    await shoot(page, shot, `${shot.name}-${theme}.png`)
  }
  await context.close()
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })

  // Ephemeral context resolves IDs valid for both themes.
  const probe = await browser.newContext()
  const login = await probe.request.post(`${BASE_URL}/api/auth/login`, {
    data: { username: USERNAME, password: PASSWORD },
  })
  if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`)
  // `SILLAGE_SHOTS=schedule,board` rebuilds only these views: other screenshots
  // stay unchanged when adding a site section.
  const only = process.env.SILLAGE_SHOTS?.split(',').map((name) => name.trim()).filter(Boolean)
  const shots = buildShots(await resolveTargets(probe)).filter((shot) => !only || only.includes(shot.name))
  await probe.close()

  for (const theme of ['dark', 'light']) {
    await captureTheme(browser, theme, shots)
  }

  await browser.close()
  console.log(`\nScreenshots written to ${OUT_DIR}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(1)
})
