#!/usr/bin/env node
/**
 * Capture site screens from an already running, seeded demo instance
 * (see `apps/server/src/cli/demo-seed.ts`, then `pnpm --filter @sillage/server
 * search:reindex` so search palette has results).
 *
 *   SILLAGE_URL=http://127.0.0.1:7517 node scripts/screenshots.mjs
 *   SILLAGE_SHOTS=schedule node scripts/screenshots.mjs   # only some views
 *   SILLAGE_DEMO_CATALOG=1 node scripts/screenshots.mjs   # no CLI credentials needed
 *   SILLAGE_SHOT_FORMAT=webp node scripts/screenshots.mjs # optimized website assets
 *   SILLAGE_SHOT_FORMAT=webp SILLAGE_SHOT_SCALE=2 node scripts/screenshots.mjs # `<name>-2x-<theme>.webp`
 * Seed after server startup to preserve the demo's running/awaiting states.
 *
 * Each view produces `<name>-dark.png` and `<name>-light.png` in `site/screenshots/`.
 * WebP output is opt-in so existing README image references keep being refreshed.
 * Consumption is opt-in via SILLAGE_SHOTS=consumption and needs seeded turn_usage
 * rows with known model pricing; the standard demo seed does not provide them.
 * `context` and `sharing` are opt-in the same way: `context` needs project memory
 * notes on Nimbus (the seed writes none) and `sharing` needs a public URL on the
 * instance, otherwise the dialog shows its configuration notice instead of the link button.
 * Locale forced to English because the site is English.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.SILLAGE_URL ?? 'http://127.0.0.1:7517'
const USERNAME = process.env.SILLAGE_DEMO_USER ?? 'alex'
const PASSWORD = process.env.SILLAGE_DEMO_PASSWORD ?? 'sillage-demo'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'screenshots')
const FORMAT = process.env.SILLAGE_SHOT_FORMAT === 'webp' ? 'webp' : 'png'
// 2x WebP serves high-density screens; the site picks it with `srcset`.
const HIGH_DENSITY = FORMAT === 'webp' && process.env.SILLAGE_SHOT_SCALE === '2'
// Four times the pixels: a lower quality keeps each file near the 1x weight class.
const WEBP_QUALITY = HIGH_DENSITY ? 0.82 : 0.94
// The theme stays last so `-light.webp` / `-dark.webp` suffix matching still works.
const fileName = (name, theme) => `${name}${HIGH_DENSITY ? '-2x' : ''}-${theme}.${FORMAT}`

// Indigo in the app's OKLCH palette; the website uses the matching accent.
// No image filters or retouching; the interface renders these colors itself.
const APPEARANCE = { hue: 275, tint: 0.25, lift: 0 }

/** Views needing data the standard seed does not write: captured only when named in SILLAGE_SHOTS. */
const OPT_IN = ['consumption', 'context', 'sharing']

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
 * palette…); `after` runs once the capture is written, to release what the view
 * holds on the server; `viewport` overrides the default size for a view.
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
      name: 'hero-mobile',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      viewport: { width: 390, height: 844 },
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
      // Unfold the tool group so the thread shows what Codex actually ran.
      interact: async (page) => {
        await page.getByRole('button', { name: /3 tools/ }).click()
        await page.getByText('pnpm test').first().waitFor({ timeout: 10000 })
      },
    },
    {
      // Toolbar action "Continue in another CLI": agent choice and context budget.
      name: 'handoff',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      interact: async (page) => {
        await page.getByRole('button', { name: 'Continue in another CLI...' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByText('Context carried over').waitFor({ timeout: 10000 })
        await dialog.getByRole('button', { name: /^Continue with / }).waitFor({ timeout: 10000 })
        // Same as the card drawer: the focused close button may show its tooltip.
        await page.evaluate(() => document.activeElement?.blur())
      },
    },
    {
      // Export dialog walked to its last step: the page preview with the link and download actions.
      name: 'sharing',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      interact: async (page) => {
        await page.getByRole('button', { name: 'Export and share' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('button', { name: 'Check private information' }).click()
        await dialog.getByRole('button', { name: 'Open the final preview' }).click()
        // The link button stays disabled until the preview frame has loaded.
        const publish = dialog.getByRole('button', { name: 'Create public link' })
        await publish.waitFor({ timeout: 20000 })
        await page.waitForFunction((button) => !button.disabled, await publish.elementHandle(), { timeout: 20000 })
        await page.evaluate(() => document.activeElement?.blur())
      },
      // Closing the dialog deletes its draft; the server allows two per account,
      // so leaving one behind per theme would block the next run.
      after: async (page) => {
        const deleted = page.waitForResponse((response) =>
          response.request().method() === 'DELETE' && response.url().includes('/api/exports/'))
        await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
        await deleted
      },
    },
    {
      // Project page, Memory category: its tab row also names instructions, skills and MCP.
      name: 'context',
      path: `/p/${t.nimbus.id}?section=memory`,
      waitFor: 'text=Index, loaded at the start of every session',
    },
    { name: 'editions', path: '/settings/notifications', waitFor: 'text=What notifies you' },
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
      name: 'wall',
      path: '/wall',
      waitFor: '.wall-tile',
      interact: async (page) => {
        await page.getByRole('button', { name: '2 col.', exact: true }).click()
      },
    },
    {
      name: 'consumption',
      path: '/consumption',
      waitFor: '[data-consumption-chart]',
    },
    {
      name: 'card',
      path: `/p/${t.nimbus.id}/board?carte=2`,
      waitFor: 'role=button[name="Edit card"]',
      viewport: BOARD_VIEWPORT,
      // The drawer focuses its close button, whose tooltip shows up or not depending on timing.
      interact: async (page) => {
        await page.evaluate(() => document.activeElement?.blur())
      },
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
      // Project settings, Worktrees category: compares each tree against main.
      name: 'worktrees',
      path: `/p/${t.nimbus.id}?section=worktrees`,
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
        await panel.getByText('forecast.ts', { exact: true }).click()
        await panel.locator('text=fromCache').first().waitFor({ timeout: 10000 })
        await panel.locator('button[title="Cache the last forecast per city"]').click()
        await panel.locator('[data-git-inspector]').waitFor({ timeout: 10000 })
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
  await writeCapture(page, file)
  console.log(`✓ ${file}`)
  if (shot.after) await shot.after(page)
}

async function writeCapture(page, file) {
  if (FORMAT === 'png') {
    await page.screenshot({ path: join(OUT_DIR, file) })
    return
  }
  // Chromium encodes the capture directly: no dependency or visual retouching.
  const png = await page.screenshot({ scale: HIGH_DENSITY ? 'device' : 'css' })
  const webp = await page.evaluate(async ({ base64, quality }) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, { base64: png.toString('base64'), quality: WEBP_QUALITY })
  writeFileSync(join(OUT_DIR, file), Buffer.from(webp))
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
    localStorage.setItem('sillage.locale', 'en')
    localStorage.setItem('sillage.theme', theme)
    document.documentElement.dataset.theme = theme
    for (const [key, value] of Object.entries(values)) {
      localStorage.setItem(`sillage.${key}`, String(value))
    }
  }, { theme, values: APPEARANCE })

  const page = await context.newPage()
  if (process.env.SILLAGE_DEMO_CATALOG === '1') {
    // Disposable instances do not use real CLI credentials. Match their seeded models.
    await context.route(/\/api\/agents\/(claude|codex)\/models(?:\?|$)/, (route) => {
      const claude = new URL(route.request().url()).pathname.includes('/claude/')
      return route.fulfill({ json: {
        models: [{
          value: claude ? 'claude-sonnet-5' : 'gpt-5.2-codex',
          displayName: claude ? 'Sonnet 5' : 'GPT-5.2 Codex',
          description: '', hint: null, isDefault: true,
          efforts: ['low', 'medium', 'high'].map((value) => ({ value, label: value, hint: '' })),
          defaultEffort: 'medium',
        }],
        modes: [], account: null, fetchedAt: Date.now(),
      } })
    })
  }
  // Capture sign-in page before setting session cookie.
  for (const shot of shots.filter((s) => s.anonymous)) {
    await shoot(page, shot, fileName(shot.name, theme))
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
    await shoot(page, shot, fileName(shot.name, theme))
  }
  await context.close()
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })

  try {
    // Ephemeral context resolves IDs valid for both themes.
    const probe = await browser.newContext()
    const login = await probe.request.post(`${BASE_URL}/api/auth/login`, {
      data: { username: USERNAME, password: PASSWORD },
    })
    if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`)
    // `SILLAGE_SHOTS=schedule,board` rebuilds only these views: other screenshots
    // stay unchanged when adding a site section.
    const only = process.env.SILLAGE_SHOTS?.split(',').map((name) => name.trim()).filter(Boolean)
    const shots = buildShots(await resolveTargets(probe)).filter((shot) =>
      only ? only.includes(shot.name) : !OPT_IN.includes(shot.name),
    )
    await probe.close()

    for (const theme of ['dark', 'light']) {
      await captureTheme(browser, theme, shots)
    }
  } finally {
    await browser.close()
  }
  console.log(`\nScreenshots written to ${OUT_DIR}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(1)
})
